# Deployment

ScholarMind deploys as a single Cloud Run service that serves both the built SPA and the API. One container, one origin, so no CORS configuration.

> The previous version of this document described a static frontend and warned that "the API key is exposed to the browser." That is no longer true: the key is server-side only and never enters the client bundle.

## Prerequisites

- A GCP project with billing enabled
- `gcloud` authenticated (`gcloud auth login && gcloud config set project YOUR_PROJECT`)
- A [Google AI Studio API key](https://aistudio.google.com/apikey)

Set once:

```bash
export PROJECT_ID=$(gcloud config get-value project)
export REGION=us-central1
export SERVICE=scholarmind
```

## 1. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com storage.googleapis.com secretmanager.googleapis.com \
  iap.googleapis.com
```

## 2. Firestore

```bash
gcloud firestore databases create --location=$REGION
```

Native mode. The app uses only document reads and simple ordered queries, so no composite indexes are needed initially; Firestore will name any it wants in an error message if that changes.

## 3. Cloud Storage

```bash
gsutil mb -l $REGION gs://$PROJECT_ID-scholarmind
gsutil uniformbucketlevelaccess set on gs://$PROJECT_ID-scholarmind
```

No public access. The bucket is reached only by the service account; the app streams bytes through `/api/blobs/*` so that ownership is checked on every read.

## 4. Secret Manager

```bash
printf 'YOUR_GEMINI_API_KEY' | gcloud secrets create gemini-api-key --data-file=-
```

The Developer API key is required because File Search is unavailable on Vertex — see [architecture](../architecture/README.md#the-developer-api-not-vertex).

## 5. Service account

A dedicated account, not the default compute one:

```bash
gcloud iam service-accounts create $SERVICE --display-name="ScholarMind runtime"
SA=$SERVICE@$PROJECT_ID.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:$SA --role=roles/datastore.user
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
gsutil iam ch serviceAccount:$SA:objectAdmin gs://$PROJECT_ID-scholarmind
```

## 6. Artifact Registry

```bash
gcloud artifacts repositories create $SERVICE --repository-format=docker --location=$REGION
```

## 7. Deploy

```bash
gcloud builds submit --config cloudbuild.yaml
```

`cloudbuild.yaml` builds the image, pushes it, and deploys with:

| Flag | Why |
| :--- | :--- |
| `--no-allow-unauthenticated` | A public URL in front of a Gemini key is a cost liability |
| `--timeout=300s` | Ingestion plus two-stage generation is slow |
| `--memory=1Gi` | PDFs are buffered in memory during indexing |
| `--min-instances=0` | Scales to zero; accepts cold starts |
| `--set-secrets` | Key injected from Secret Manager, never baked into the image |

## 8. IAP

Deployed private, the service needs IAP to give real users access — and IAP is what supplies the identity the app stores data against.

1. Put an external HTTPS load balancer in front of the Cloud Run service (serverless NEG).
2. Enable IAP on the backend service.
3. Grant access:

```bash
gcloud iap web add-iam-policy-binding \
  --resource-type=backend-services --service=YOUR_BACKEND_SERVICE \
  --member=user:someone@example.com --role=roles/iap.httpsResourceAccessor
```

4. Set `IAP_AUDIENCE` on the service to `/projects/PROJECT_NUMBER/global/backendServices/BACKEND_SERVICE_ID`.

**Without `IAP_AUDIENCE` the server rejects every request in production.** That is deliberate: it will not accept an unverified identity header.

## Environment variables

| Variable | Required | Notes |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | yes | From Secret Manager |
| `GOOGLE_CLOUD_PROJECT` | yes | Set by Cloud Run |
| `GCS_BUCKET` | yes | Absent falls back to the local filesystem, which is ephemeral on Cloud Run |
| `IAP_AUDIENCE` | yes | Assertions are refused without it |
| `NODE_ENV=production` | yes | Enables IAP verification |
| `UNPAYWALL_EMAIL` | no | Enables Unpaywall lookup; their terms require a contact address |
| `FILE_SEARCH_STORE_PREFIX` | no | Useful for separating environments |

## Verifying

```bash
TOKEN=$(gcloud auth print-identity-token)
curl -H "Authorization: Bearer $TOKEN" https://YOUR_SERVICE_URL/api/healthz
```

Expect `geminiKey: "configured"`, `firestore: "cloud"`, `blobs: "gcs"`. Unauthenticated requests should return 401.

## Costs

Cloud Run scales to zero, and Firestore and Cloud Storage usage is small. Gemini calls dominate: each processed paper is two generation calls plus speech and image generation, and File Search charges for embeddings at indexing time.
