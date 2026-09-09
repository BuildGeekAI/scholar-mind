# Deployment

Two Cloud Run services off one image: the API (which also serves the built SPA)
and the queue worker. One container, one origin, no CORS configuration.

> This runbook is written from an actual provisioning of `scholar-mind-dev`,
> including the things that went wrong. The obstacles below are not hypothetical.

---

## Target topology

```mermaid
flowchart TB
    U([Users]) --> CR

    CR["Cloud Run: scholarmind<br/><i>dist/ + /api/*</i>"]
    W["Cloud Run: scholarmind-worker<br/><i>min-instances=1</i>"]
    J["Cloud Run Job: scholarmind-migrate"]

    CR --> SQL[("Cloud SQL Postgres 17<br/><b>private IP only</b>")]
    W --> SQL
    J --> SQL

    CR --> GCS[("Cloud Storage")]
    W --> GCS
    CR --> SM[["Secret Manager"]]
    CR --> FB{{"Firebase Auth<br/><i>email + password</i>"}}
    CR --> GEM["Gemini Developer API"]
    W --> GEM

    style CR fill:#f0f9ff,stroke:#0284c7
    style W fill:#ecfdf5,stroke:#059669
    style FB fill:#fef3c7,stroke:#d97706
    style GEM fill:#f5f3ff,stroke:#7c3aed
```

**The database has no public IP.** An org policy (`constraints/sql.restrictPublicIp`)
forbids it, which is the right policy and shapes everything else: Cloud Run reaches
Postgres by **Direct VPC egress** rather than the Cloud SQL connector, and nothing
outside the VPC can reach it — including your laptop. Migrations therefore run as
a Cloud Run Job.

**The worker is a service, not a Job.** The queue is long-lived and pull-based; a
Job per unit of work would mean an invocation per paper. It runs
`--min-instances=1`, because a polling worker that scales to zero never claims
anything and the queue simply stops draining.

---

## Prerequisites

```bash
export PROJECT_ID=scholar-mind-dev
export REGION=us-central1
export SERVICE=scholarmind
```

## 1. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com secretmanager.googleapis.com storage.googleapis.com \
  compute.googleapis.com servicenetworking.googleapis.com \
  firebase.googleapis.com identitytoolkit.googleapis.com apikeys.googleapis.com \
  --project=$PROJECT_ID
```

## 2. Private networking for Cloud SQL

Required before the instance exists, not after.

```bash
gcloud compute addresses create google-managed-services-default \
  --global --purpose=VPC_PEERING --addresses=10.60.0.0 --prefix-length=16 \
  --network=default --project=$PROJECT_ID

gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-default \
  --network=default --project=$PROJECT_ID
```

## 3. Cloud SQL

```bash
gcloud sql instances create scholarmind-dev \
  --project=$PROJECT_ID --region=$REGION \
  --database-version=POSTGRES_17 \
  --edition=ENTERPRISE --tier=db-f1-micro \
  --storage-size=10GB --storage-type=HDD --no-backup \
  --network=projects/$PROJECT_ID/global/networks/default --no-assign-ip \
  --root-password="$(openssl rand -base64 24)" --async

gcloud sql databases create scholarmind --instance=scholarmind-dev --project=$PROJECT_ID
gcloud sql users create scholarmind --instance=scholarmind-dev --password=… --project=$PROJECT_ID
```

Creation takes ten to fifteen minutes. Note the private IP:

```bash
gcloud sql instances describe scholarmind-dev --project=$PROJECT_ID \
  --format="value(ipAddresses[0].ipAddress)"
```

> `--tier=db-f1-micro` requires `--edition=ENTERPRISE`. The default edition is
> ENTERPRISE_PLUS, which rejects shared-core tiers.

## 4. Cloud Storage

```bash
gcloud storage buckets create gs://$PROJECT_ID-scholarmind \
  --project=$PROJECT_ID --location=$REGION \
  --uniform-bucket-level-access --public-access-prevention
```

## 5. Secrets

```bash
printf 'postgres://scholarmind:PASSWORD@PRIVATE_IP:5432/scholarmind' \
  | gcloud secrets create scholarmind-database-url --project=$PROJECT_ID \
      --replication-policy=automatic --data-file=-

printf 'YOUR_GEMINI_KEY' \
  | gcloud secrets create gemini-api-key --project=$PROJECT_ID \
      --replication-policy=automatic --data-file=-
```

URL-encode the password. Cloud Run resolves `:latest` **at deploy time**, so a new
secret version needs a new revision — pin an explicit version if you want that
to be visible.

## 6. Service account and IAM

```bash
gcloud iam service-accounts create $SERVICE --project=$PROJECT_ID
SA=$SERVICE@$PROJECT_ID.iam.gserviceaccount.com

for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SA" --role="$role" --condition=None
done

gcloud storage buckets add-iam-policy-binding gs://$PROJECT_ID-scholarmind \
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin --project=$PROJECT_ID
```

**Cloud Build also needs permissions.** Builds now run as the Compute Engine
default service account, which on a new project has none — the failure is a 403
on the *source upload*, which reads like a bucket problem rather than an IAM one.

```bash
CB=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com
for role in roles/cloudbuild.builds.builder roles/storage.admin \
            roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$CB" --role="$role" --condition=None
done
```

## 7. Firebase Authentication

Entirely scriptable — there is no console step. (A Google OAuth *web client*, by
contrast, has no API at all; the only CLI surface was shut down in March 2026.)

```bash
TOKEN=$(gcloud auth print-access-token)

curl -X POST -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT_ID" \
  -H "Content-Type: application/json" \
  "https://identitytoolkit.googleapis.com/v2/projects/$PROJECT_ID/identityPlatform:initializeAuth" -d '{}'

curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT_ID" \
  -H "Content-Type: application/json" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}'

gcloud services api-keys create --project=$PROJECT_ID --display-name="ScholarMind Web"
gcloud services api-keys get-key-string <UID> --project=$PROJECT_ID --format="value(keyString)"
```

The Web API key is **public by design** — it identifies the project and
authorises nothing. Pass it as an environment variable, not a secret.

## 8. Artifact Registry and build

```bash
gcloud artifacts repositories create $SERVICE --repository-format=docker \
  --location=$REGION --project=$PROJECT_ID

gcloud builds submit --project=$PROJECT_ID --region=$REGION \
  --tag=$REGION-docker.pkg.dev/$PROJECT_ID/$SERVICE/$SERVICE:$(git rev-parse --short HEAD) .
```

## 9. Migrate, then deploy

**Schema first.** The service assumes it.

```bash
IMG=$REGION-docker.pkg.dev/$PROJECT_ID/$SERVICE/$SERVICE:$(git rev-parse --short HEAD)

gcloud run jobs deploy $SERVICE-migrate \
  --project=$PROJECT_ID --region=$REGION --image=$IMG \
  --service-account=$SA \
  --command=npx --args=tsx,server/db/migrate.ts \
  --set-secrets=DATABASE_URL=scholarmind-database-url:latest \
  --network=default --subnet=default --vpc-egress=private-ranges-only \
  --max-retries=1 --task-timeout=600s

gcloud run jobs execute $SERVICE-migrate --project=$PROJECT_ID --region=$REGION --wait
```

> **The job pins an image.** Adding a migration and redeploying only the services
> leaves the schema behind, and the failure surfaces as a 500 with `column "…"
> does not exist`. Update the job every time. `cloudbuild.yaml` does this; a
> hand-rolled deploy does not.

Then the services. Environment values containing commas — `AUTH_ALLOWED_DOMAINS`
— break `--set-env-vars`, whose own delimiter is a comma, so use a file:

```yaml
# api-env.yaml
NODE_ENV: production
GCS_BUCKET: scholar-mind-dev-scholarmind
ACL_ENABLED: "true"
FIREBASE_PROJECT_ID: scholar-mind-dev
FIREBASE_WEB_API_KEY: AIza…
AUTH_ALLOWED_DOMAINS: example.com,example.org
```

```bash
gcloud run deploy $SERVICE \
  --project=$PROJECT_ID --region=$REGION --image=$IMG \
  --service-account=$SA --env-vars-file=api-env.yaml \
  --set-secrets=GEMINI_API_KEY=gemini-api-key:latest,DATABASE_URL=scholarmind-database-url:latest \
  --network=default --subnet=default --vpc-egress=private-ranges-only \
  --min-instances=0 --memory=1Gi --timeout=300s --concurrency=80

gcloud run deploy $SERVICE-worker \
  --project=$PROJECT_ID --region=$REGION --image=$IMG \
  --service-account=$SA --env-vars-file=worker-env.yaml \
  --command=npx --args=tsx,server/worker.ts \
  --set-secrets=GEMINI_API_KEY=gemini-api-key:latest,DATABASE_URL=scholarmind-database-url:latest \
  --network=default --subnet=default --vpc-egress=private-ranges-only \
  --min-instances=1 --max-instances=4 --memory=1Gi \
  --timeout=3600s --concurrency=1 --no-cpu-throttling
```

> **The worker binds `$PORT`.** It takes its work from the queue, not from HTTP,
> but Cloud Run will not start a service that does not listen and health-checks
> the port before sending traffic. `server/worker.ts` serves a small health
> endpoint for exactly this reason, and answers 503 while draining.

---

## Environment

| Variable | Where | Notes |
| --- | --- | --- |
| `NODE_ENV=production` | env | **Required on Cloud Run.** Startup aborts without it; every caller would otherwise be the same dev user |
| `AUTH_ALLOWED_DOMAINS` | env | **Required on Cloud Run.** Startup aborts without it. `*` means open registration, deliberately |
| `DATABASE_URL` | secret | Private IP; URL-encode the password |
| `GEMINI_API_KEY` | secret | |
| `FIREBASE_PROJECT_ID` | env | |
| `FIREBASE_WEB_API_KEY` | env | Public by design |
| `GCS_BUCKET` | env | Without it, blobs go to container-local disk and vanish |
| `ACL_ENABLED=true` | env | Defaults on in production, but stated explicitly — `--set-env-vars` replaces the *whole* set, and this is the one whose silent absence is invisible |
| `EMBEDDING_DIM` | job only | Needed once, to apply `0004_embeddings.sql` |

## Verify

```bash
curl https://<service-url>/api/healthz
{"ok":true,"geminiKey":"configured","database":"reachable","acl":"enforced","blobs":"gcs"}
```

Then sign up with an allowed domain and confirm the address; an unverified
account is refused by design. A full check is one crawl: create a library, search
a scholar, and watch `/api/profiles/:id/status` until the run reaches
`succeeded`.

## Cost

Dominated by two always-on things: the Cloud SQL instance and the worker's
`--min-instances=1`. The API scales to zero. Stop the SQL instance when idle:

```bash
gcloud sql instances patch scholarmind-dev --activation-policy=NEVER --project=$PROJECT_ID
```
