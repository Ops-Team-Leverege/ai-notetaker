"""
Entry point for the Zoom bot — one-shot script.

Reads meeting details from environment variables, joins the meeting,
records audio, uploads to GCS, enqueues transcription, then exits.

Logging goes to both Cloud Logging and stdout (for serial console / docker logs).
"""

import os
import sys
import logging

# Set up logging to stdout FIRST so we see output even if Cloud Logging fails
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [zoom-bot] %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("zoom-bot")

# Try to also send logs to Cloud Logging (non-fatal if it fails)
try:
    import google.cloud.logging
    _logging_client = google.cloud.logging.Client()
    _logging_client.setup_logging(log_level=logging.INFO)
    logger.info("Cloud Logging initialized")
except Exception as e:
    logger.warning("Cloud Logging not available, using stdout only: %s", e)


def main():
    logger.info("zoom-bot starting up")

    meeting_id = os.environ.get("BOT_MEETING_ID")
    meeting_number_str = os.environ.get("BOT_MEETING_NUMBER")
    passcode = os.environ.get("BOT_PASSCODE")
    owning_user = os.environ.get("BOT_OWNING_USER")
    display_name = os.environ.get("BOT_DISPLAY_NAME", "Leverege Notetaker")

    if not all([meeting_id, meeting_number_str, passcode, owning_user]):
        logger.error(
            "Missing required env vars. Got: BOT_MEETING_ID=%s BOT_MEETING_NUMBER=%s BOT_PASSCODE=%s BOT_OWNING_USER=%s",
            meeting_id, meeting_number_str, "***" if passcode else None, owning_user,
        )
        sys.exit(1)

    meeting_number = int(meeting_number_str)

    logger.info(
        "Starting zoom-bot for meeting %s (number=%d, user=%s, displayName=%s)",
        meeting_id, meeting_number, owning_user, display_name,
    )

    from src.bot import ZoomMeetingBot

    bot = ZoomMeetingBot(
        meeting_id=meeting_id,
        meeting_number=meeting_number,
        passcode=passcode,
        owning_user=owning_user,
        display_name=display_name,
    )
    bot.run()
    logger.info("zoom-bot exiting normally")


if __name__ == "__main__":
    main()
