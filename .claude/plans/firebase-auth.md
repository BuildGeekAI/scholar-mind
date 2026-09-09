# Plan: Email and password sign-in via Firebase Authentication

**Status:** TEST complete — 276 unit + 61 integration, all passing. Phase 6 (docs) is `/release`
**Phase:** IMPLEMENT
**Supersedes in part:** the server-side Google OAuth flow in `server/googleAuth.ts` (see D1)

## Requirement

Let people sign in with an email address and a password, using Firebase Authentication as the identity provider, in place of the server-side Google OAuth flow built earlier today.

---

## What exists, and what this displaces

Sign-in today is a server-side OAuth authorization code exchange: `/api/auth/google` redirects to Google, `/api/auth/callback` exchanges the code, verifies the ID token, and issues a session cookie backed by a revocable `sessions` row. `identity.ts` resolves a caller in this order: **API key → session cookie → IAP → dev user**.

Firebase Auth is a different shape. The *client* signs in and receives a Firebase ID token; the server's job is to verify that token rather than to run the flow. These are not two settings of one mechanism — they put the login in two different places.

Everything downstream is unaffected: `sessions`, `users`, `resolveContext`, the tenancy triple, API keys and every ACL stay exactly as they are.

---

## Decisions

### D1 — Firebase replaces the server-side Google OAuth flow
Firebase Auth also does Google sign-in, so keeping both leaves two code paths reaching the same outcome — the shape `server/router.ts` already warns against for the API ("one implementation — do not add a separate dev-only API path"), and the shape that produces bugs which only appear on one path.

`server/googleAuth.ts` keeps its session half (`signIn`, `verifySession`, `signOut`, `purgeExpiredSessions`, the cookie helpers) and loses its OAuth half (`authorizationUrl`, `exchangeCode`, the `state` cookie, `/api/auth/google`, `/api/auth/callback`). The file is renamed `server/session.ts`, because it will no longer be about Google.

**This deletes code written earlier today.** That is the right call rather than an embarrassing one: it was the correct design for "Google sign-in, no IAP", and the requirement has changed to include passwords. Keeping it as well would cost more than deleting it.

IAP verification stays untouched — it is dormant unless `NODE_ENV=production` and no session exists, and removing it is a separate decision.

### D2 — Verify Firebase ID tokens with no new server dependency
A Firebase ID token is an ordinary JWT: issuer `https://securetoken.google.com/<projectId>`, audience `<projectId>`, signed with Google's *securetoken* keys.

`identity.ts` already verifies IAP assertions with `OAuth2Client.verifySignedJwtWithCertsAsync(jwt, certs, audience, issuers)`. The same call verifies a Firebase token given the right certs, which are a plain JSON map of `kid` → PEM at a well-known URL. So this needs **a fetch and a cache, not `firebase-admin`**.

That matters beyond tidiness: `firebase-admin` is a large dependency that pulls in its own gRPC and credential machinery, for one JWT verification we can already do. It also matches how this repository has consistently chosen — no dotenv, no migration framework, no cookie parser.

Certs are cached in memory and refreshed on the `max-age` in the response's `Cache-Control` header, which is how Google publishes their rotation.

### D3 — The client uses Firebase's REST API, not the Firebase SDK
`firebase/auth` is a substantial client dependency; the current bundle is 441 KB and this would be a material fraction of that again.

The main reason to take the SDK is its token-refresh machinery — and **D4 removes that need entirely**. Sign-in, sign-up, password reset and email verification are all single REST calls to `identitytoolkit.googleapis.com` with the Web API key. No SDK, no bundle cost, no new client dependency.

The Web API key is public by design; it identifies the project and authorises nothing. The plan states this explicitly so nobody later "hides" it in a way that breaks the client.

### D4 — Exchange the Firebase token for the existing session cookie
The client signs in with Firebase, gets an ID token, and posts it once to `/api/auth/firebase`. The server verifies it and issues the same session cookie the OAuth flow issued.

```
client → identitytoolkit signInWithPassword → ID token
       → POST /api/auth/firebase { idToken }
       → server verifies, upserts user, sets sm_session
       → every subsequent request is an ordinary cookie request
```

Why not send the Firebase ID token on every request instead:
- Firebase ID tokens expire in an hour and need refreshing. Every `fetch` in `services/api.ts` would need an Authorization header and a refresh path; today they need neither.
- A Firebase token cannot be revoked server-side without `firebase-admin`. A session row can, and `sessions` already exists with sign-out and expiry tests around it.
- SSE and blob URLs are plain browser requests (`<img src>`, `EventSource`-shaped fetches) where attaching a header is awkward. A cookie just works.

**The cost, stated plainly:** signing out of Firebase on the client does not end our session. `POST /api/auth/signout` must be called too, and the client does both. A session outlives a Firebase revocation until it expires — acceptable at a 30-day session for this app, and the reason `SESSION_DAYS` is configurable.

### D5 — An unverified email address cannot sign in
Anyone can register any address with a password. `email_verified` is already required in the Google path for the same reason, and the consequence is sharper here: an unverified address that matches an allowlisted domain would otherwise get into that domain's org.

Registration therefore sends a verification email (one REST call) and refuses the session until the address is verified. The sign-in screen says so and offers to resend.

### D6 — Signup policy is the open question, and email/password makes it urgent
With Google-only sign-in, `AUTH_ALLOWED_DOMAINS` unset at least meant "anyone with a Google account". With passwords it means *anyone at all* — and new users land in the demo org, where profiles default to `org`-visible and are therefore readable by every member.

Three ways to close it, and this plan cannot pick for you:
1. **Set `AUTH_ALLOWED_DOMAINS`** — only listed domains may register. Simplest, and the domain still picks the org.
2. **Change the default visibility to `private`** — signup stays open, sharing becomes deliberate. Safe, but loses the "public by default" behaviour originally asked for.
3. **Each new user gets their own org** — safe by default, but "org" stops meaning organisation until an invitation flow exists, and there isn't one.

**Recommended: (1) now, because it is one environment variable.** (2) and (3) are product changes.

### D7 — Existing accounts do not carry over
`users.external_id` is `google:<sub>` for the server-side OAuth flow and would become `firebase:<uid>`. Firebase mints its own uid, so the same human signing in through Firebase becomes a *new* row with a new tenancy and no libraries.

On `scholar-mind-dev` this is irrelevant — the only account is the seeded demo user. It is recorded because it stops being irrelevant the moment anyone real signs in.

---

## Data model

Almost none. `sessions` and `users` are unchanged.

```sql
-- 0008_firebase.sql
-- Firebase uid is the identity; the address can change and must not be the key.
-- external_id already carries a prefixed identity, so nothing structural changes.
-- Recorded only so the provider is visible in the row rather than inferred
-- from a string prefix.
ALTER TABLE users ADD COLUMN auth_provider text NOT NULL DEFAULT 'unknown';
UPDATE users SET auth_provider = split_part(external_id, ':', 1)
  WHERE external_id LIKE '%:%';
```

---

## Implementation

### [x] Phase 1 — Server verification
- `server/firebaseAuth.ts`
  - `verifyFirebaseToken(idToken)` — fetch and cache the securetoken certs, verify with `verifySignedJwtWithCertsAsync` against issuer `https://securetoken.google.com/<project>` and audience `<project>`, return `{ uid, email, emailVerified, name, picture, signInProvider }`.
  - Returns `null` for every failure alike, so a caller cannot distinguish "unknown token" from "wrong signature".
- `server/session.ts` — `googleAuth.ts` renamed, OAuth half removed, session half unchanged.
- `server/identity.ts` — imports move; the resolution order is untouched.
- `0008_firebase.sql`.

### [x] Phase 2 — Endpoints
- `POST /api/auth/firebase` — `{ idToken }` → verify → D5 check → `domainAllowed` → upsert user → session cookie. Returns `{ email, name }` or a typed refusal (`unverified`, `domain`, `invalid`).
- `GET /api/auth/config` — returns the Firebase Web API key and project id so the client can call the REST API, plus whether sign-in is configured at all.
- `POST /api/auth/signout` — unchanged.
- Delete `/api/auth/google` and `/api/auth/callback`.

### [x] Phase 3 — Client
- `services/firebase.ts` — thin REST wrapper, no SDK:
  - `signUp(email, password)` → `accounts:signUp`
  - `signIn(email, password)` → `accounts:signInWithPassword`
  - `sendVerification(idToken)` / `sendPasswordReset(email)` → `accounts:sendOobCode`
  - Maps Firebase's error codes (`EMAIL_NOT_FOUND`, `INVALID_LOGIN_CREDENTIALS`, `EMAIL_EXISTS`, `WEAK_PASSWORD`, `TOO_MANY_ATTEMPTS_TRY_LATER`) to sentences a person can act on. Firebase deliberately returns the same code for a wrong password and an unknown address; the message must not leak which.
- `services/api.ts` — `exchangeFirebaseToken`, `signOut` calls both sides.
- `components/SignIn.tsx` — rewritten: email, password, sign-up toggle, forgot-password, resend-verification. It currently offers a Google button that will no longer exist.

### [x] Phase 4 — Configuration and deployment
- `.env.example` — `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY`; remove `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`; keep `AUTH_ALLOWED_DOMAINS` with a sharper warning per D6.
- `cloudbuild.yaml` — the two new variables on both services.
- Provisioning, which is manual and console-only: enable Firebase on `scholar-mind-dev`, turn on the Email/Password provider, add the Cloud Run domain to authorised domains, read off the Web API key.

### [x] Phase 5 — Tests
Unit, no network:
- Cert cache — refreshes on expiry, reuses within it, survives a failed refresh by keeping the previous set.
- Token rejection — wrong issuer, wrong audience, expired, malformed. Every one returns `null`, and the tests assert they are *indistinguishable*.
- `email_verified === false` is refused (D5).
- `domainAllowed` against the Firebase payload, including the `hd`-less consumer case.
- Firebase error-code mapping, including that wrong-password and unknown-address produce the same message.

Integration (`TEST_DATABASE_URL`):
- A verified token creates the user and a working session.
- The same uid with a changed address resolves to the same person.
- A second sign-in creates a second session and does not disturb the first.
- Sign-out kills one session and leaves the other.

### Phase 6 — Docs
`docs/deployment/README.md` (Firebase setup replaces the OAuth client steps), `docs/api/README.md` (`/auth/firebase` replaces `/auth/google` and `/auth/callback`), `CLAUDE.md` (the auth order, and that Firebase tokens are verified without `firebase-admin` — worth stating, because reaching for the SDK is the obvious instinct).

---

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Open signup into a shared org** where profiles are org-readable. The real risk in this plan. | D6, decided before deploy, not after. |
| R2 | **Deleting working OAuth code** and finding Firebase does not cover a case. | Firebase Auth covers Google sign-in as a provider, so the capability is not lost; it moves. One commit, revertible. |
| R3 | **Cert rotation** — a stale cache rejects every valid token, which looks like total auth failure. | Honour `Cache-Control`, refetch on unknown `kid`, keep the previous set if a refresh fails. |
| R4 | **Firebase sign-out does not end our session** (D4). | Client calls both; `SESSION_DAYS` is tunable. Named here so it is a decision rather than a surprise. |
| R5 | **Password handling is entirely Firebase's** — reset, lockout, breach lists. That is the point of using it, but it means an outage there is an outage here. | Accepted. API keys keep working during one, since they do not touch Firebase. |
| R6 | **Existing accounts do not carry over** (D7). | Fine now; will not be later. |

---

## Open questions

1. **D6** — which of the three signup policies, and if (1), which domains? The unresolved `AUTH_ALLOWED_DOMAINS: central` needs to become a real value.
2. **Does IAP support stay?** It is dead code on this deployment. Removing it simplifies `identity.ts`; keeping it costs nothing.
3. **Should Google sign-in remain available through Firebase**, alongside passwords? One extra provider, one extra button, no server change.


---

## Implementation log

### Provisioning turned out to be fully automatable
The plan listed Firebase setup as manual console work. It is not: Firebase Auth is Identity
Platform underneath, and that has an admin API. Done entirely over the API —
`identityPlatform:initializeAuth`, `PATCH /admin/v2/projects/{p}/config` to enable the
email/password provider, and `gcloud services api-keys create` for the Web key.

This matters beyond convenience. A **Google OAuth Web client has no API at all** — the only CLI
surface was `gcloud alpha iap oauth-clients`, which Google shut down in March 2026 and which
produced IAP-bound clients with fixed redirect URIs anyway. So the provider that could be automated
was the one the plan chose, and the stopgap that could not be was the one it deletes.

### Every assumption was checked against a live token, not from memory

```
alg RS256, kid present          → verifySignedJwtWithCertsAsync applies
iss https://securetoken.google.com/scholar-mind-dev
aud scholar-mind-dev
sign_in_provider password
certs: 4 keys, cache-control max-age=20631
email_verified: FALSE on a fresh signup
```

That last line is why D5 has teeth: an unverified address is the *default state* of every new
password account, not an edge case.

### What was built

| Phase | Result |
| --- | --- |
| 1 | `server/firebaseAuth.ts` — cert fetch and cache, token verification, **no `firebase-admin`**; `googleAuth.ts` → `session.ts`, OAuth half removed, `signIn` now provider-agnostic; `0008_firebase.sql` |
| 2 | `POST /auth/firebase`, `GET /auth/config`, `POST /auth/signout`; `/auth/google` and `/auth/callback` deleted |
| 3 | `services/firebase.ts` — REST, **no SDK**; `SignIn.tsx` rewritten with sign-up, reset and resend |
| 4 | `.env.example`, `cloudbuild.yaml`, and the startup guard below |

Bundle went 441 KB → 445 KB. The no-SDK decision cost 4 KB.

### D6 made structural rather than advisory
The plan recommended "set `AUTH_ALLOWED_DOMAINS`", which is a deployment instruction and therefore
forgettable. Since sign-in now means anyone who can receive email, an unset allowlist is a data
exposure rather than a lax door policy — so `server/env.ts` **refuses to start on Cloud Run without
it**, in the same fail-closed shape as the existing `NODE_ENV` guard. `*` is how a deployment says
open registration is deliberate; empty says it by omission, which is the case worth catching.

Verified: `K_SERVICE=scholarmind NODE_ENV=production` with no allowlist aborts with the reason.

### Verified live, end to end

| Step | Result |
| --- | --- |
| `GET /auth/config` | reports the project and the public Web key |
| Exchange an **unverified** token | 403 `unverified` — no session |
| Exchange a **verified** token | session cookie set, `auth/me` returns the address and org |
| Use the session | 200 |
| Sign out, then reuse the cookie | **401 in production** |
| No cookie in production | 401 |
| Malformed token / wrong project audience | 401, indistinguishable from each other |
| `users.auth_provider` | recorded as `firebase` |

Probe accounts deleted from both Firebase and Postgres.

### Deviations

**`redirectUri` and `PUBLIC_ORIGIN` are gone from the auth path.** There is no redirect flow any
more, so nothing needs to know the public origin to sign someone in. `PUBLIC_ORIGIN` stays in
`cloudbuild.yaml` because it remains useful for absolute URLs, but auth no longer depends on it —
which removes the misconfiguration that would have broken the OAuth flow on the deployed service.

**`isConfigured()` moved meaning.** It reported whether a Google OAuth client existed; it now reports
whether any provider can issue sessions.

### Still to do

- Phase 5 (tests) — `/test`. The cert cache, token rejection, and the Firebase error-code mapping
  are all pure and testable without network.
- Phase 6 (docs) — `/release`.
- **Open question 1 (D6) is still unanswered**, and now blocks deployment rather than merely being
  advisable: the service will not start without `AUTH_ALLOWED_DOMAINS`. `central` is not a usable
  value.


---

## Test log

**276 unit tests (network-free) + 61 integration cases**, all passing. Typecheck and build clean.

| File | Cases | What it pins |
| --- | --- | --- |
| `firebaseAuth.test.ts` | 12 | cert cache, rotation handling, uniform rejection |
| `firebaseClient.test.ts` | 11 | REST shape and the error-code mapping |
| `session.test.ts` | 12 | domain policy, including the `*` escape hatch |
| `env.test.ts` | 16 | both fail-closed startup guards |

### Three existing tests broke, correctly
`env.test.ts` set up Cloud Run scenarios without `AUTH_ALLOWED_DOMAINS`, which the new guard now
refuses. Their premise changed rather than their assertion being wrong, so they were given the
variable and a dedicated block was added for the guard itself. Nothing was weakened.

### The two properties most worth having tests for

**Rejection is uniform.** Six forged shapes — unsigned, `alg: none`, wrong audience, wrong issuer,
two-segment, and outright garbage — all return `null`, asserted as a set rather than one by one. A
caller who could distinguish them could probe a forgery towards a working token.

**Wrong password and unknown address say the same thing.** Firebase returns one code for both, and
the test asserts all three variants (`EMAIL_NOT_FOUND`, `INVALID_PASSWORD`,
`INVALID_LOGIN_CREDENTIALS`) map to an identical message. Splitting them would make the form *more*
helpful and turn it into a way to discover who has an account — a regression that would look like an
improvement in review.

### The cert cache, which is where a quiet bug would be loudest
Four cases: fetch once and reuse within the published lifetime; **refetch on an unknown `kid`**,
because that is what a key rotation looks like and without it every freshly-signed token is rejected
until the cache happens to expire; refetch after expiry; and keep the previous keys when a refresh
fails, because stale keys still verify tokens signed before the rotation whereas no keys reject
everything and present as a total outage.

### Manual verification, against live Firebase

| Step | Result |
| --- | --- |
| `GET /auth/config` | project id and public Web key |
| Exchange an **unverified** token | 403 `unverified`, no session |
| Exchange a **verified** token | session cookie set |
| `GET /auth/me` with the cookie | address and org |
| Sign out, reuse the cookie | **401 in production** |
| No cookie in production | 401 |
| `users.auth_provider` | `firebase` |
| Cloud Run without `AUTH_ALLOWED_DOMAINS` | refuses to start, with the reason |

Probe accounts deleted from Firebase and Postgres.

### Untested

- **The `SignIn` component.** Its logic was exercised through the API it calls, not by rendering it.
  No component-test harness exists in this repo and neither plan added one.
- **Email delivery.** `sendOobCode` is asserted to be *called* correctly; whether Firebase's default
  templates actually arrive is unverified, and worth one manual signup before real users.
- **Session expiry in the wild** — `SESSION_DAYS` is tested at the boundary by manipulating
  `expires_at`, not by waiting.
