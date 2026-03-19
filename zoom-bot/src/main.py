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

# =============================================================================
# STDOUT LOGGING — set up FIRST, before ANY other imports.
# This ensures we see output even if subsequent imports crash.
# =============================================================================
_stdout_handler = logging.StreamHandler(sys.stdout)
_stdout_handler.setFormatter(logging.Formatter("%(asctime)s [zoom-bot] %(levelname)s %(message)s"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [zoom-bot] %(levelname)s %(message)s",
    stream=sys.stdout,
    force=True,
)
logger = logging.getLogger("zoom-bot")

# Immediately log that we're alive (print + logger for redundancy)
print("[zoom-bot] Process started", flush=True)
logger.info("zoom-bot main.py loaded, Python %s", sys.version)

# Try to also send logs to Cloud Logging (non-fatal if it fails).
# IMPORTANT: setup_logging() replaces root logger handlers, which kills stdout.
# We must re-add our stdout handler AFTER Cloud Logging setup.
try:
    import google.cloud.logging as gcl
    _logging_client = gcl.Client()
    _logging_client.setup_logging(log_level=logging.INFO)
    # Re-add stdout handler — Cloud Logging's setup_logging() removes it
    root_logger = logging.getLogger()
    root_logger.addHandler(_stdout_handler)
    logger.addHandler(_stdout_handler)
    logger.info("Cloud Logging initialized (stdout handler re-added)")
except Exception as e:
    logger.warning("Cloud Logging not available: %s", e)

# Flush after setup to make sure the above lines are visible
sys.stdout.flush()
sys.stderr.flush()


# =============================================================================
# Early import validation — catch missing native libraries before main()
# =============================================================================
print("[zoom-bot] Validating critical imports...", flush=True)

try:
    import zoom_meeting_sdk as zoom
    print(f"[zoom-bot] zoom_meeting_sdk imported OK (version={getattr(zoom, '__version__', 'unknown')})", flush=True)
    logger.info("zoom_meeting_sdk imported successfully")
except Exception as e:
    print(f"[zoom-bot] FATAL: Failed to import zoom_meeting_sdk: {e}", flush=True)
    logger.exception("Failed to import zoom_meeting_sdk")
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()
    sys.exit(1)

try:
    import gi
    gi.require_version("GLib", "2.0")
    from gi.repository import GLib
    print("[zoom-bot] GLib imported OK", flush=True)
    logger.info("GLib imported successfully")
except Exception as e:
    print(f"[zoom-bot] FATAL: Failed to import GLib: {e}", flush=True)
    logger.exception("Failed to import GLib")
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()
    sys.exit(1)

try:
    import jwt
    import requests
    from google.cloud import secretmanager
    print("[zoom-bot] All Python dependencies imported OK", flush=True)
    logger.info("All Python dependencies imported successfully")
except Exception as e:
    print(f"[zoom-bot] FATAL: Failed to import dependencies: {e}", flush=True)
    logger.exception("Failed to import dependencies")
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()
    sys.exit(1)

sys.stdout.flush()


def main():
    """Main entry point — reads env vars, creates bot, runs it."""
    try:
        logger.info("=== zoom-bot main() starting ===")
        print("[zoom-bot] main() starting", flush=True)

        logger.info("Reading environment variables...")

        meeting_id = os.environ.get("BOT_MEETING_ID")
        meeting_number_str = os.environ.get("BOT_MEETING_NUMBER")
        passcode = os.environ.get("BOT_PASSCODE")
        owning_user = os.environ.get("BOT_OWNING_USER")
        display_name = os.environ.get("BOT_DISPLAY_NAME", "Leverege Notetaker")

        logger.info("ENV: BOT_MEETING_ID=%s BOT_MEETING_NUMBER=%s BOT_OWNING_USER=%s BOT_DISPLAY_NAME=%s",
                     meeting_id, meeting_number_str, owning_user, display_name)
        print(f"[zoom-bot] ENV: meeting_id={meeting_id} meeting_number={meeting_number_str} user={owning_user}", flush=True)

        if not all([meeting_id, meeting_number_str, passcode, owning_user]):
            logger.error("Missing required env vars: meeting_id=%s number=%s passcode=%s user=%s",
                         bool(meeting_id), bool(meeting_number_str), bool(passcode), bool(owning_user))
            print("[zoom-bot] FATAL: Missing required env vars", flush=True)
            sys.exit(1)

        meeting_number = int(meeting_number_str)

        logger.info("Importing ZoomMeetingBot...")
        print("[zoom-bot] Importing ZoomMeetingBot...", flush=True)
        from src.bot import ZoomMeetingBot
        logger.info("ZoomMeetingBot imported successfully")
        print("[zoom-bot] ZoomMeetingBot imported OK", flush=True)

        bot = ZoomMeetingBot(
            meeting_id=meeting_id,
            meeting_number=meeting_number,
            passcode=passcode,
            owning_user=owning_user,
            display_name=display_name,
        )
        logger.info("Bot created, calling run()...")
        print("[zoom-bot] Bot created, calling run()...", flush=True)
        sys.stdout.flush()

        bot.run()

        logger.info("zoom-bot exiting normally")
        print("[zoom-bot] Exiting normally", flush=True)
    except SystemExit:
        raise
    except Exception:
        error_msg = traceback.format_exc()
        logger.error("FATAL ERROR in main():\n%s", error_msg)
        print(f"[zoom-bot] FATAL ERROR in main():\n{error_msg}", file=sys.stdout, flush=True)
        print(error_msg, file=sys.stderr, flush=True)
        sys.stdout.flush()
        sys.stderr.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
