terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required GCP APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "storage.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "eventarc.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "compute.googleapis.com",
    "workspaceevents.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}
