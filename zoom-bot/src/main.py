"""
Entry point for the Zoom bot subprocess.

Reads meeting details from environment variables and runs the bot.
Initializes Google Cloud Logging first so all logs appear in Cloud Logging.
"""

import os
import sys

# Initialize Cloud Logging BEFORE any other imports that use logging
import google.cloud.logging
_logging_client = google.cloud.logging.Client()
_logging_client.setup_logging()

import logging

logger = logging.getLogger("zoom-bot")
logger.setLevel(logging.INFO)


def main():
    meeting_id = os.environ.get("BOT_MEETING_ID")
    meeting_number_str = os.environ.get("BOT_MEETING_NUMBER")
    passcode = os.environ.get("BOT_PASSCODE")
    owning_user = os.environ.get("BOT_OWNING_USER")
    display_name = os.environ.get("BOT_DISPLAY_NAME", "Leverege Notetaker")

    if not all([meeting_id, meeting_number_str, passcode, owning_user]):
        logger.error("Missing required env vars: BOT_MEETING_ID, BOT_MEETING_NUMBER, BOT_PASSCODE, BOT_OWNING_USER")
        sys.exit(1)

    meeting_number = int(meeting_number_str)

    logger.info("Starting zoom-bot for meeting %s (number=%d, user=%s, displayName=%s)",
                meeting_id, meeting_number, owning_user, display_name)

    from src.bot import ZoomMeetingBot

    bot = ZoomMeetingBot(
        meeting_id=meeting_id,
        meeting_number=meeting_number,
        passcode=passcode,
        owning_user=owning_user,
        display_name=display_name,
    )
    bot.run()


if __name__ == "__main__":
    main()
