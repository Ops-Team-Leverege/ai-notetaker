variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for resources"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for zonal resources"
  type        = string
  default     = "us-central1-a"
}

variable "cloud_run_transcription_worker_url" {
  description = "URL of the Cloud Run transcription worker service (for Eventarc and Cloud Tasks targets)"
  type        = string
  default     = "https://transcription-worker-PLACEHOLDER.run.app"
}

variable "backend_api_url" {
  description = "URL of the Cloud Run backend API service (for Workspace Events push notifications)"
  type        = string
  default     = "https://backend-api-PLACEHOLDER.run.app"
}

variable "cloud_sql_tier" {
  description = "Cloud SQL instance tier"
  type        = string
  default     = "db-f1-micro"
}

variable "cloud_sql_database_name" {
  description = "Cloud SQL database name"
  type        = string
  default     = "notetaker"
}
