# Task 0.2 — Cloud SQL instance (PostgreSQL)

resource "google_sql_database_instance" "main" {
  name             = "notetaker-db"
  database_version = "POSTGRES_15"
  region           = var.region
  project          = var.project_id

  settings {
    tier              = var.cloud_sql_tier
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled = true
      # In production, restrict to Cloud Run connector / private IP.
      # For initial setup, allow Cloud SQL Auth Proxy connections.
    }

    backup_configuration {
      enabled = true
    }

    # Encryption at rest is enabled by default on Cloud SQL (Google-managed keys)
  }

  deletion_protection = false # Set to true for production

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "notetaker" {
  name     = var.cloud_sql_database_name
  instance = google_sql_database_instance.main.name
  project  = var.project_id
}

resource "google_sql_user" "app" {
  name     = "notetaker_app"
  instance = google_sql_database_instance.main.name
  project  = var.project_id
  password = "CHANGE_ME_AFTER_DEPLOY" # Replace via Secret Manager after initial deploy
}
