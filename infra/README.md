# Leverege Meeting Notetaker — GCP Infrastructure

Terraform configuration for the Meeting Notetaker GCP infrastructure.

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`)
- A GCP project with billing enabled
- `gcloud auth application-default login` completed

## Quick Start

```bash
cd infra

# Initialize Terraform
terraform init

# Create a terraform.tfvars file with your project settings
cat > terraform.tfvars <<EOF
project_id = "your-gcp-project-id"
region     = "us-central1"
EOF

# Preview changes
terraform plan

# Apply infrastructure
terraform apply
```

## Post-Deploy Steps

### 1. Run Database Migrations

After the Cloud SQL instance is provisioned, run the SQL migrations:

```bash
# Connect via Cloud SQL Auth Proxy
cloud-sql-proxy your-project:us-central1:notetaker-db &

# Run migrations in order
psql -h 127.0.0.1 -U notetaker_app -d notetaker \
  -f migrations/001_create_meetings.sql \
  -f migrations/002_create_speaker_labels.sql \
  -f migrations/003_create_sessions.sql
```

### 2. Update Secret Manager Values

Replace placeholder values in Secret Manager with real credentials:

```bash
# Google OAuth credentials
echo -n "real-client-id" | gcloud secrets versions add google-oauth-client-id --data-file=-
echo -n "real-client-secret" | gcloud secrets versions add google-oauth-client-secret --data-file=-

# Zoom credentials
echo -n '{"email":"real@email.com","password":"real-password"}' | \
  gcloud secrets versions add zoom-account-credentials --data-file=-

# Microsoft credentials
echo -n '{"email":"real@email.com","password":"real-password"}' | \
  gcloud secrets versions add microsoft-account-credentials --data-file=-

# Cloud SQL connection string
echo -n "postgresql://notetaker_app:REAL_PASSWORD@/notetaker?host=/cloudsql/PROJECT:REGION:notetaker-db" | \
  gcloud secrets versions add cloudsql-connection-string --data-file=-
```

### 3. Register Workspace Events API Subscription

```bash
export PROJECT_ID="your-gcp-project-id"
export BACKEND_API_URL="https://backend-api-xxx.run.app"
./scripts/register-workspace-events.sh
```

This requires a user account with Google Workspace admin access. See `scripts/register-workspace-events.sh` for details.

### 4. Deploy Cloud Run Services

After infrastructure is provisioned, deploy the Cloud Run services. The Eventarc trigger expects a Cloud Run service named `transcription-worker` in the configured region.

### 5. Update Terraform Variables

Once Cloud Run services are deployed, update `terraform.tfvars` with the actual service URLs:

```hcl
cloud_run_transcription_worker_url = "https://transcription-worker-xxx.run.app"
backend_api_url                    = "https://backend-api-xxx.run.app"
```

Then re-run `terraform apply` to update the Eventarc trigger and Cloud Scheduler targets.

## Resources Created

| Resource | Description |
|----------|-------------|
| `leverege-notetaker-audio` bucket | Audio file storage (7-day lifecycle cleanup) |
| `leverege-notetaker-transcripts` bucket | Transcript JSON storage |
| `notetaker-db` Cloud SQL | PostgreSQL 15 instance |
| Secret Manager secrets | Google OAuth, Zoom, Microsoft, Cloud SQL credentials |
| `audio-upload-trigger` Eventarc | GCS object-finalized → transcription worker |
| `transcription-queue` Cloud Tasks | Max 5 concurrent dispatches, exponential backoff |
| `nightly-session-cleanup` Cloud Scheduler | Runs at 2 AM ET daily |
| `notetaker-bot` service account | Storage Writer, Cloud SQL Client |
| `transcription-worker` service account | Compute Admin, Storage Admin, Cloud SQL Client |
| `pipeline` service account | Storage Admin, Cloud SQL Client, Compute Instance Admin |
| `workspace-events` Pub/Sub topic | Workspace Events API delivery |

## SQL Migrations

Located in `migrations/`:

| File | Description |
|------|-------------|
| `001_create_meetings.sql` | meetings table with status constraints and indexes |
| `002_create_speaker_labels.sql` | speaker label overrides with FK to meetings |
| `003_create_sessions.sql` | auth sessions with expiry index |
