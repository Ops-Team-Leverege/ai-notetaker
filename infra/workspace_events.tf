# Task 0.8 — Workspace Events API subscription
#
# The Google Workspace Events API subscription cannot be fully provisioned via Terraform
# because it requires an OAuth 2.0 user-context token (not a service account) and
# domain-wide delegation setup in Google Workspace Admin.
#
# This file documents the required configuration and provides a helper script.
#
# The subscription must be created via the Workspace Events API:
#   POST https://workspaceevents.googleapis.com/v1/subscriptions
#
# Payload:
# {
#   "targetResource": "//meet.googleapis.com/spaces/-",
#   "eventTypes": ["google.workspace.meet.conference.v2.ended"],
#   "notificationEndpoint": {
#     "pubsubTopic": "projects/{project_id}/topics/workspace-events"
#   },
#   "payloadOptions": {
#     "includeResource": true
#   }
# }
#
# Alternatively, push notifications can be delivered directly to the backend API
# webhook endpoint: POST /api/workspace/events
#
# Prerequisites:
# 1. Enable the Google Workspace Events API in the GCP project
# 2. Configure domain-wide delegation for the service account
# 3. Create the subscription using an authorized OAuth token
# 4. The backend API must verify Google-signed push notification headers

# Pub/Sub topic for Workspace Events (if using Pub/Sub delivery)
resource "google_pubsub_topic" "workspace_events" {
  name    = "workspace-events"
  project = var.project_id

  depends_on = [google_project_service.apis]
}

# Pub/Sub subscription that pushes to the backend API
resource "google_pubsub_subscription" "workspace_events_push" {
  name    = "workspace-events-push"
  topic   = google_pubsub_topic.workspace_events.name
  project = var.project_id

  push_config {
    push_endpoint = "${var.backend_api_url}/api/workspace/events"

    oidc_token {
      service_account_email = google_service_account.pipeline.email
    }
  }

  ack_deadline_seconds = 30

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  depends_on = [google_project_service.apis]
}
