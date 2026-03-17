"""
Flask app for the Zoom bot service.

Receives job requests from the API to join a Zoom meeting.
Runs the bot in a subprocess so the Flask health endpoint stays responsive.

Endpoints:
  POST /join  — Start a bot to join a meeting
  GET  /health — Health check
"""

import logging
import os
import subprocess
import sys
import threading

from flask import Flask, jsonify, request

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format="[zoom-bot-app] %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Track active bot process
_active_process: subprocess.Popen | None = None
_lock = threading.Lock()


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


@app.route("/join", methods=["POST"])
def join_meeting():
    """
    Start the Zoom bot to join a meeting.

    Expected JSON body:
      {
        "meetingId": "our-internal-uuid",
        "meetingNumber": 1234567890,
        "passcode": "abc123",
        "owningUser": "user@example.com"
      }
    """
    global _active_process

    data = request.get_json(force=True)
    meeting_id = data.get("meetingId")
    meeting_number = data.get("meetingNumber")
    passcode = data.get("passcode")
    owning_user = data.get("owningUser")

    if not all([meeting_id, meeting_number, passcode, owning_user]):
        return jsonify({"error": "Missing required fields"}), 400

    with _lock:
        if _active_process and _active_process.poll() is None:
            return jsonify({"error": "Bot is already in a meeting"}), 409

    # Run the bot as a subprocess so this endpoint returns immediately
    env = {**os.environ, **{
        "BOT_MEETING_ID": str(meeting_id),
        "BOT_MEETING_NUMBER": str(meeting_number),
        "BOT_PASSCODE": str(passcode),
        "BOT_OWNING_USER": str(owning_user),
    }}

    proc = subprocess.Popen(
        [sys.executable, "-m", "src.main"],
        env=env,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )

    with _lock:
        _active_process = proc

    logger.info("Started bot process (pid=%d) for meeting %s", proc.pid, meeting_id)
    return jsonify({"status": "started", "meetingId": meeting_id, "pid": proc.pid}), 202


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
