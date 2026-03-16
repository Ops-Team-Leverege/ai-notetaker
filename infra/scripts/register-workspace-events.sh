#!/usr/bin/env bash
# Task 0.8 — Register Workspace Events API subscription
#
# This script creates a Google Workspace Events API subscription that delivers
# push notifications to the backend API when a Google Meet session ends.
#
# Prerequisites:
#   1. gcloud CLI authenticated with a user account that has Workspace admin access
#   2. Google Workspace Events API enabled in the GCP project
#   3. Domain-wide delegation configured for the service account
#   4. Backend API deployed and accessible at BACKEND_API_URL
#
# Usage:
#   export PROJECT_ID="your-gcp-project-id"
#   export BACKEND_API_URL="https://backend-api-xxx.run.app"
#   ./register-workspace-events.sh

set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID environment variable}"
: "${BACKEND_API_URL:?Set BACKEND_API_URL environment variable}"

TOPIC="projects/${PROJECT_ID}/topics/workspace-events"

echo "Registering Workspace Events API subscription..."
echo "  Project: ${PROJECT_ID}"
echo "  Topic:   ${TOPIC}"
echo "  Push endpoint: ${BACKEND_API_URL}/api/workspace/events"

# Get an OAuth access token (requires user login with Workspace admin scope)
ACCESS_TOKEN=$(gcloud auth print-access-token)

curl -s -X POST \
  "https://workspaceevents.googleapis.com/v1/subscriptions" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"targetResource\": \"//meet.googleapis.com/spaces/-\",
    \"eventTypes\": [\"google.workspace.meet.conference.v2.ended\"],
    \"notificationEndpoint\": {
      \"pubsubTopic\": \"${TOPIC}\"
    },
    \"payloadOptions\": {
      \"includeResource\": true
    }
  }"

echo ""
echo "Subscription registered. Push notifications will be delivered via Pub/Sub → ${BACKEND_API_URL}/api/workspace/events"
