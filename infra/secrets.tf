# Task 0.3 — Secret Manager secrets with placeholder values

resource "google_secret_manager_secret" "google_oauth_client_id" {
  secret_id = "google-oauth-client-id"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_oauth_client_id" {
  secret      = google_secret_manager_secret.google_oauth_client_id.id
  secret_data = "PLACEHOLDER_GOOGLE_OAUTH_CLIENT_ID"
}

resource "google_secret_manager_secret" "google_oauth_client_secret" {
  secret_id = "google-oauth-client-secret"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_oauth_client_secret" {
  secret      = google_secret_manager_secret.google_oauth_client_secret.id
  secret_data = "PLACEHOLDER_GOOGLE_OAUTH_CLIENT_SECRET"
}

resource "google_secret_manager_secret" "zoom_account_credentials" {
  secret_id = "zoom-account-credentials"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "zoom_account_credentials" {
  secret      = google_secret_manager_secret.zoom_account_credentials.id
  secret_data = jsonencode({ email = "PLACEHOLDER", password = "PLACEHOLDER" })
}

resource "google_secret_manager_secret" "microsoft_account_credentials" {
  secret_id = "microsoft-account-credentials"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "microsoft_account_credentials" {
  secret      = google_secret_manager_secret.microsoft_account_credentials.id
  secret_data = jsonencode({ email = "PLACEHOLDER", password = "PLACEHOLDER" })
}

resource "google_secret_manager_secret" "cloudsql_connection_string" {
  secret_id = "cloudsql-connection-string"
  project   = var.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "cloudsql_connection_string" {
  secret      = google_secret_manager_secret.cloudsql_connection_string.id
  secret_data = "postgresql://notetaker_app:CHANGE_ME@localhost:5432/notetaker?host=/cloudsql/${var.project_id}:${var.region}:notetaker-db"
}
