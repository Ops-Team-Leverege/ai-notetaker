# Task 0.4 — Eventarc trigger on audio bucket for object-finalized events
# Triggers POST /internal/trigger-transcription on the Cloud Run transcription worker

# Grant Eventarc permission to receive GCS events
resource "google_project_iam_member" "eventarc_gcs_sa" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.transcription_worker.email}"
}

# The GCS service account needs pubsub.publisher role for Eventarc to work
data "google_storage_project_service_account" "gcs_sa" {
  project = var.project_id
}

resource "google_project_iam_member" "gcs_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_storage_project_service_account.gcs_sa.email_address}"
}

resource "google_eventarc_trigger" "audio_upload" {
  name     = "audio-upload-trigger"
  location = var.region
  project  = var.project_id

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.storage.object.v1.finalized"
  }

  matching_criteria {
    attribute = "bucket"
    value     = google_storage_bucket.audio.name
  }

  destination {
    cloud_run_service {
      service = "transcription-worker" # Cloud Run service name — must match deployed service
      region  = var.region
      path    = "/internal/trigger-transcription"
    }
  }

  service_account = google_service_account.transcription_worker.email

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.eventarc_gcs_sa,
    google_project_iam_member.gcs_pubsub_publisher,
  ]
}
