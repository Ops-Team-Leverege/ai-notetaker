# Task 0.5 — Cloud Tasks queue with maxConcurrentDispatches: 5 and exponential backoff

resource "google_cloud_tasks_queue" "transcription" {
  name     = "transcription-queue"
  location = var.region
  project  = var.project_id

  rate_limits {
    max_concurrent_dispatches = 5
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "10s"
    max_backoff        = "300s"
    max_doublings      = 4
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.apis]
}
