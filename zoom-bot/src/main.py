"""
Entry point for the Zoom bot — one-shot script.

Reads meeting details from environment variables, joins the meeting,
records audio, uploads to GCS, enqueues transcription, then exits.

Logging goes to both Cloud Logging and stdout (for serial console / docker logs).
"""

import os
import sys
import logging
import traceback

# Set up stdout logging FIRST — before ANY other imports
# This ensures we see output even if subsequent imports crash
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [zoom-bot] %(levelname)s %(message)s",
    stream=sys.stdout,
    force=True,
)
logger = logging.getLogger("zoom-bot")

# Immediately log that we're alive
print("[zoom-bot] Process started", flush=True)
logger.info("zoom-bot main.py loaded, Python %s", sys.version)

# Try to also send logs to Cloud Logging (non-fatal if it fails)
try:
    import google.cloud.logging as gcl
    _logging_client = gcl.Client()
    _logging_client.setup_logging(log_level=logging.INFO)
    logger.info("Cloud Logging initialized")
except Exception as e:
    logger.warning("Cloud Logging not available: %s", e)


def main():
    try:
        logger.info("Reading environment variables...")

        meeting_id = os.environ.get("BOT_MEETING_ID")
        meeting_number_str = os.environ.get("BOT_MEETING_NUMBER")
        passcode = os.environ.get("BOT_PASSCODE")
        owning_user = os.environ.get("BOT_OWNING_USER")
        display_name = os.environ.get("BOT_DISPLAY_NAME", "Leverege Notetaker")

        logger.info("ENV: BOT_MEETING_ID=%s BOT_MEETING_NUMBER=%s BOT_OWNING_USER=%s BOT_DISPLAY_NAME=%s",
                     meeting_id, meeting_number_str, owning_user, display_name)

        if not all([meeting_id, meeting_number_str, passcode, owning_user]):
            logger.error("Missing required env vars")
            sys.exit(1)

        meeting_number = int(meeting_number_str)

        logger.info("Importing ZoomMeetingBot...")
        from src.bot import ZoomMeetingBot
        logger.info("ZoomMeetingBot imported successfully")

        bot = ZoomMeetingBot(
            meeting_id=meeting_id,
            meeting_number=meeting_number,
            passcode=passcode,
            owning_user=owning_user,
            display_name=display_name,
        )
        logger.info("Bot created, calling run()...")
        bot.run()
        logger.info("zoom-bot exiting normally")
    except Exception:
        logger.error("FATAL ERROR in main():\n%s", traceback.format_exc())
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
