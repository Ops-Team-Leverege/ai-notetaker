# Task 0.1 — Cloud Storage buckets with Google-managed encryption
# Layout: gs://leverege-notetaker-audio/{owning_user_hash}/{meeting_id}/audio.wav
#         gs://leverege-notetaker-transcripts/{owning_user_hash}/{meeting_id}/transcript.json

resource "google_storage_bucket" "audio" {
  name     = "leverege-notetaker-audio"
  location = var.region
  project  = var.project_id

  # Google-managed encryption is the default — no explicit key config needed.
  # All objects are encrypted at rest with Google-managed keys automatically.

  uniform_bucket_level_access = true

  # Audio files are deleted after transcription completes.
  # Add a safety-net lifecycle rule to catch any orphaned files.
  lifecycle_rule {
    condition {
      age = 7 # days
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = false
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket" "transcripts" {
  name     = "leverege-notetaker-transcripts"
  location = var.region
  project  = var.project_id

  # Google-managed encryption at rest (default)

  uniform_bucket_level_access = true

  versioning {
    enabled = false
  }

  depends_on = [google_project_service.apis]
}

# Per-user path IAM is enforced at the application layer via owning_user_hash path prefixes.
# Bucket-level IAM grants are scoped to service accounts (see iam.tf).
# Fine-grained object-level ACLs are not used — uniform bucket-level access is enabled.
