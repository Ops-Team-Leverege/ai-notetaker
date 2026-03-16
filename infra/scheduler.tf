# Task 0.6 — Cloud Scheduler job for nightly session cleanup
# Executes: DELETE FROM sessions WHERE expires_at < NOW()
# Targets the backend API endpoint that runs the cleanup query.

resource "google_cloud_scheduler_job" "session_cleanup" {
  name        = "nightly-session-cleanup"
  description = "Delete expired sessions from Cloud SQL nightly"
  schedule    = "0 2 * * *" # 2:00 AM daily
  time_zone   = "America/New_York"
  project     = var.project_id
  region      = var.region

  http_target {
    http_method = "POST"
    uri         = "${var.backend_api_url}/internal/cleanup-sessions"

    oidc_token {
      service_account_email = google_service_account.pipeline.email
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "10s"
    max_backoff_duration = "300s"
  }

  depends_on = [google_project_service.apis]
}
