# Task 0.7 — Service accounts with minimum required IAM roles

# --- notetaker-bot@ (Storage Writer, Cloud SQL Client) ---
resource "google_service_account" "notetaker_bot" {
  account_id   = "notetaker-bot"
  display_name = "Notetaker Bot"
  description  = "Service account for the Playwright headless bot that joins meetings and uploads audio"
  project      = var.project_id
}

resource "google_project_iam_member" "notetaker_bot_storage_writer" {
  project = var.project_id
  role    = "roles/storage.objectCreator"
  member  = "serviceAccount:${google_service_account.notetaker_bot.email}"
}

resource "google_project_iam_member" "notetaker_bot_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.notetaker_bot.email}"
}

# Grant bot access to secrets (platform credentials)
resource "google_secret_manager_secret_iam_member" "bot_google_oauth_id" {
  secret_id = google_secret_manager_secret.google_oauth_client_id.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.notetaker_bot.email}"
}

resource "google_secret_manager_secret_iam_member" "bot_google_oauth_secret" {
  secret_id = google_secret_manager_secret.google_oauth_client_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.notetaker_bot.email}"
}

resource "google_secret_manager_secret_iam_member" "bot_zoom_creds" {
  secret_id = google_secret_manager_secret.zoom_account_credentials.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.notetaker_bot.email}"
}

resource "google_secret_manager_secret_iam_member" "bot_microsoft_creds" {
  secret_id = google_secret_manager_secret.microsoft_account_credentials.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.notetaker_bot.email}"
}

# --- transcription-worker@ (Compute Admin, Storage Admin, Cloud SQL Client) ---
resource "google_service_account" "transcription_worker" {
  account_id   = "transcription-worker"
  display_name = "Transcription Worker"
  description  = "Service account for the Cloud Run transcription worker that manages T4 GPU instances"
  project      = var.project_id
}

resource "google_project_iam_member" "transcription_worker_compute_admin" {
  project = var.project_id
  role    = "roles/compute.admin"
  member  = "serviceAccount:${google_service_account.transcription_worker.email}"
}

resource "google_project_iam_member" "transcription_worker_storage_admin" {
  project = var.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:${google_service_account.transcription_worker.email}"
}

resource "google_project_iam_member" "transcription_worker_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.transcription_worker.email}"
}

# Transcription worker needs to create Cloud Tasks jobs
resource "google_project_iam_member" "transcription_worker_tasks_enqueuer" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.transcription_worker.email}"
}

# --- pipeline@ (Storage Admin, Cloud SQL Client) ---
resource "google_service_account" "pipeline" {
  account_id   = "pipeline"
  display_name = "Pipeline"
  description  = "Service account for the transcription pipeline running on T4 GPU instances"
  project      = var.project_id
}

resource "google_project_iam_member" "pipeline_storage_admin" {
  project = var.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:${google_service_account.pipeline.email}"
}

resource "google_project_iam_member" "pipeline_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.pipeline.email}"
}

# Pipeline needs to delete its own Compute Engine instance (self-shutdown)
resource "google_project_iam_member" "pipeline_compute_instance_admin" {
  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_service_account.pipeline.email}"
}

# Grant pipeline access to Cloud SQL connection string secret
resource "google_secret_manager_secret_iam_member" "pipeline_sql_secret" {
  secret_id = google_secret_manager_secret.cloudsql_connection_string.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pipeline.email}"
}

# Grant transcription worker access to Cloud SQL connection string secret
resource "google_secret_manager_secret_iam_member" "worker_sql_secret" {
  secret_id = google_secret_manager_secret.cloudsql_connection_string.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.transcription_worker.email}"
}
