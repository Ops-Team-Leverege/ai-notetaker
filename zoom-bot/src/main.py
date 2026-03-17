"""
Entry point for the Zoom bot subprocess.

Reads meeting details from environment variables and runs the bot.
"""

import os
import sys
import logging

logging.basicConfig(level=logging.INFO, format="[zoom-bot] %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def main():
    meeting_id = os.environ.get("BOT_MEETING_ID")
    meeting_number_str = os.environ.get("BOT_MEETING_NUMBER")
    passcode = os.environ.get("BOT_PASSCODE")
    owning_user = os.environ.get("BOT_OWNING_USER")

    if not all([meeting_id, meeting_number_str, passcode, owning_user]):
        logger.error("Missing required env vars: BOT_MEETING_ID, BOT_MEETING_NUMBER, BOT_PASSCODE, BOT_OWNING_USER")
        sys.exit(1)

    meeting_number = int(meeting_number_str)

    from src.bot import ZoomMeetingBot

    bot = ZoomMeetingBot(
        meeting_id=meeting_id,
        meeting_number=meeting_number,
        passcode=passcode,
        owning_user=owning_user,
    )
    bot.run()


if __name__ == "__main__":
    main()
