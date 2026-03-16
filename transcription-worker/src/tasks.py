"""Cloud Tasks job creation with retry logic."""

import json
import os
import time
import logging
from google.cloud import tasks_v2

logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "ai-meeting-notetaker-490206")
REGION = os.environ.get("GCP_REGION", "us-central1")
QUEUE_NAME = os.environ.get("CLOUD_TASKS_QUEUE", "transcription-queue")
WORKER_URL = os.environ.get("TRANSCRIPTION_WORKER_URL", "")

MAX_RETRIES = 3
BACKOFF_BASE = 1  # seconds


def create_transcription_task(
    meeting_id: str,
    audio_gcs_path: str,
    owning_user: str,
    retry_count: int = 0,
) -> bool:
    """
    Create a Cloud Tasks job for transcription.
    Retries up to 3 times with exponential backoff.
    Returns True if task was created, False on final failure.
    """
    payload = {
        "meetingId": meeting_id,
        "audioGcsPath": audio_gcs_path,
        "owningUser": owning_user,
        "retryCount": retry_count,
    }

    queue_path = f"projects/{PROJECT_ID}/locations/{REGION}/queues/{QUEUE_NAME}"
    target_url = f"{WORKER_URL}/tasks/transcribe"

    client = tasks_v2.CloudTasksClient()

    for attempt in range(MAX_RETRIES):
        try:
            task = tasks_v2.Task(
                http_request=tasks_v2.HttpRequest(
                    http_method=tasks_v2.HttpMethod.POST,
                    url=target_url,
                    headers={"Content-Type": "application/json"},
                    body=json.dumps(payload).encode(),
                ),
            )
            client.create_task(parent=queue_path, task=task)
            logger.info("Created transcription task for meeting %s", meeting_id)
            return True
        except Exception:
            logger.exception(
                "Failed to create Cloud Tasks job (attempt %d/%d) for meeting %s",
                attempt + 1,
                MAX_RETRIES,
                meeting_id,
            )
            if attempt < MAX_RETRIES - 1:
                time.sleep(BACKOFF_BASE * (2 ** attempt))

    logger.error(
        "All %d attempts to create Cloud Tasks job failed for meeting %s",
        MAX_RETRIES,
        meeting_id,
    )
    return False
