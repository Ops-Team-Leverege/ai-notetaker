"""Flask app for the Transcription Worker Cloud Run service."""

import logging
import os
from flask import Flask, request, jsonify

try:
    from .db import update_meeting_status
    from .tasks import create_transcription_task
    from .gpu import create_gpu_instance
except ImportError:
    from db import update_meeting_status
    from tasks import create_transcription_task
    from gpu import create_gpu_instance

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

AUDIO_BUCKET = os.environ.get("AUDIO_BUCKET", "leverege-notetaker-audio")


@app.route("/internal/trigger-transcription", methods=["POST"])
def trigger_transcription():
    """
    Eventarc handler: receive GCS object-finalized event.
    Extract audio path and meeting metadata, create Cloud Tasks job.
    """
    event = request.get_json(silent=True) or {}

    # Extract GCS event attributes
    message = event.get("message", {})
    attributes = message.get("attributes", {})
    bucket_id = attributes.get("bucketId", "")
    object_id = attributes.get("objectId", "")

    if not bucket_id or not object_id:
        logger.error("Missing bucketId or objectId in Eventarc event")
        return jsonify({"error": "Missing event attributes"}), 400

    audio_gcs_path = f"gs://{bucket_id}/{object_id}"

    # Extract meeting_id and owning_user from object metadata
    # Object path pattern: {owning_user_hash}/{meeting_id}/audio.wav
    # We need the actual owning_user from GCS object metadata
    metadata = attributes.get("metadata", {})
    meeting_id = metadata.get("meeting_id", "")
    owning_user = metadata.get("owning_user", "")

    # Fallback: parse meeting_id from object path
    if not meeting_id:
        parts = object_id.split("/")
        if len(parts) >= 2:
            meeting_id = parts[1]

    if not meeting_id:
        logger.error("Could not extract meeting_id from event")
        return jsonify({"error": "Missing meeting_id"}), 400

    # Update meeting status to transcription_pending
    try:
        update_meeting_status(meeting_id, "transcription_pending")
    except Exception:
        logger.exception("Failed to update meeting status for %s", meeting_id)

    # Create Cloud Tasks job with retry
    success = create_transcription_task(
        meeting_id=meeting_id,
        audio_gcs_path=audio_gcs_path,
        owning_user=owning_user,
        retry_count=0,
    )

    if not success:
        logger.error(
            "Failed to create Cloud Tasks job for meeting %s after all retries",
            meeting_id,
        )
        # Leave status as transcription_pending — Cloud Tasks may retry Eventarc delivery
        return jsonify({"status": "task_creation_failed"}), 200

    return jsonify({"status": "task_created", "meetingId": meeting_id}), 200


@app.route("/tasks/transcribe", methods=["POST"])
def handle_transcribe_task():
    """
    Cloud Tasks handler: receive TranscriptionTask payload.
    Check retry count, create GPU instance, poll for completion.
    """
    payload = request.get_json(silent=True) or {}

    meeting_id = payload.get("meetingId", "")
    audio_gcs_path = payload.get("audioGcsPath", "")
    owning_user = payload.get("owningUser", "")
    retry_count = payload.get("retryCount", 0)

    if not meeting_id or not audio_gcs_path:
        return jsonify({"error": "Missing required fields"}), 400

    # Check retry limit — retryCount >= 4 means 5th attempt, mark failed
    if retry_count >= 4:
        logger.error(
            "Meeting %s exceeded max retries (%d), marking transcription_failed",
            meeting_id,
            retry_count,
        )
        try:
            update_meeting_status(meeting_id, "transcription_failed")
        except Exception:
            logger.exception("Failed to update status to transcription_failed")
        return jsonify({"status": "max_retries_exceeded"}), 200

    # Update status to processing
    try:
        update_meeting_status(meeting_id, "processing")
    except Exception:
        logger.exception("Failed to update meeting status to processing")

    # Create preemptible T4 GPU instance
    try:
        instance_name = create_gpu_instance(
            meeting_id=meeting_id,
            audio_gcs_path=audio_gcs_path,
            owning_user=owning_user,
            retry_count=retry_count,
        )
        logger.info("Created GPU instance %s for meeting %s", instance_name, meeting_id)
        return jsonify({"status": "instance_created", "instance": instance_name}), 200
    except Exception:
        logger.exception("Failed to create GPU instance for meeting %s", meeting_id)
        return jsonify({"error": "GPU instance creation failed"}), 500
