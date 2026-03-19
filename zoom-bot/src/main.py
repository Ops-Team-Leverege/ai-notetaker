"""
Entry point for the Zoom bot — one-shot script.

LOGGING STRATEGY:
  - Every diagnostic line uses BOTH print(flush=True) AND logger.info()
  - print() goes to stdout (serial console / docker logs)
  - logger.info() goes to Cloud Logging (survives VM deletion)
  - We need both because the VM self-deletes, destroying serial console
"""

import os
import sys
import logging
import time
import traceback


def log(msg):
    """Log to both stdout and Cloud Logging."""
    print(f"[zoom-bot] {msg}", flush=True)
    try:
        logger.info(msg)
    except Exception:
        pass


# =============================================================================
# STEP 1: STDOUT + Cloud Logging setup
# =============================================================================
print("[zoom-bot] === Process starting ===", flush=True)

_stdout_handler = logging.StreamHandler(sys.stdout)
_stdout_handler.setFormatter(logging.Formatter("%(asctime)s [zoom-bot] %(levelname)s %(message)s"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [zoom-bot] %(levelname)s %(message)s",
    stream=sys.stdout,
    force=True,
)
logger = logging.getLogger("zoom-bot")

log(f"Python {sys.version}")

try:
    import google.cloud.logging as gcl
    _logging_client = gcl.Client()
    _logging_client.setup_logging(log_level=logging.INFO)
    # Re-add stdout handler after Cloud Logging replaces handlers
    logging.getLogger().addHandler(_stdout_handler)
    logger.addHandler(_stdout_handler)
    log("Cloud Logging initialized")
except Exception as e:
    log(f"Cloud Logging not available: {e}")


# =============================================================================
# STEP 2: Validate critical imports
# =============================================================================
log("--- Import validation ---")

log("Importing zoom_meeting_sdk...")
try:
    import zoom_meeting_sdk as zoom
    log(f"zoom_meeting_sdk OK (version={getattr(zoom, '__version__', 'unknown')})")
except Exception as e:
    log(f"FATAL: zoom_meeting_sdk import failed: {e}")
    logger.exception("zoom_meeting_sdk import failed")
    sys.exit(1)

log("Importing GLib...")
try:
    import gi
    gi.require_version("GLib", "2.0")
    from gi.repository import GLib
    log("GLib OK")
except Exception as e:
    log(f"FATAL: GLib import failed: {e}")
    logger.exception("GLib import failed")
    sys.exit(1)

log("Importing jwt, requests, secretmanager...")
try:
    import jwt
    import requests
    from google.cloud import secretmanager
    log("jwt, requests, secretmanager OK")
except Exception as e:
    log(f"FATAL: dependency import failed: {e}")
    logger.exception("dependency import failed")
    sys.exit(1)

log("--- All imports OK ---")


# =============================================================================
# STEP 3: main()
# =============================================================================
def main():
    """Main entry point — reads env vars, creates bot, runs it."""
    log("=== main() entered ===")

    # --- Read env vars ---
    log("Reading environment variables...")
    meeting_id = os.environ.get("BOT_MEETING_ID")
    meeting_number_str = os.environ.get("BOT_MEETING_NUMBER")
    passcode = os.environ.get("BOT_PASSCODE")
    owning_user = os.environ.get("BOT_OWNING_USER")
    display_name = os.environ.get("BOT_DISPLAY_NAME", "Leverege Notetaker")

    log(f"BOT_MEETING_ID={meeting_id}")
    log(f"BOT_MEETING_NUMBER={meeting_number_str}")
    log(f"BOT_PASSCODE={'(set)' if passcode else '(NOT SET)'}")
    log(f"BOT_OWNING_USER={owning_user}")
    log(f"BOT_DISPLAY_NAME={display_name}")

    if not meeting_id:
        log("FATAL: BOT_MEETING_ID is not set")
        return 1
    if not meeting_number_str:
        log("FATAL: BOT_MEETING_NUMBER is not set")
        return 1
    if not passcode:
        log("FATAL: BOT_PASSCODE is not set")
        return 1
    if not owning_user:
        log("FATAL: BOT_OWNING_USER is not set")
        return 1

    try:
        meeting_number = int(meeting_number_str)
    except ValueError:
        log(f"FATAL: BOT_MEETING_NUMBER not a valid int: {meeting_number_str}")
        return 1

    log(f"Env vars OK. Meeting {meeting_number} for {owning_user}")

    # --- Import and create bot ---
    log("Importing ZoomMeetingBot...")
    try:
        from src.bot import ZoomMeetingBot
        log("ZoomMeetingBot imported OK")
    except Exception as e:
        log(f"FATAL: ZoomMeetingBot import failed: {e}")
        logger.exception("ZoomMeetingBot import failed")
        return 1

    log("Creating ZoomMeetingBot instance...")
    try:
        bot = ZoomMeetingBot(
            meeting_id=meeting_id,
            meeting_number=meeting_number,
            passcode=passcode,
            owning_user=owning_user,
            display_name=display_name,
        )
        log("Bot instance created OK")
    except Exception as e:
        log(f"FATAL: Bot creation failed: {e}")
        logger.exception("Bot creation failed")
        return 1

    # --- Run the bot ---
    log("Calling bot.run()...")
    try:
        bot.run()
        log("bot.run() completed normally")
        return 0
    except Exception as e:
        log(f"FATAL: bot.run() crashed: {e}")
        logger.exception("bot.run() crashed")
        return 1


# =============================================================================
# STEP 4: VM self-deletion
# =============================================================================
def _delete_own_vm():
    """Delete this VM via the GCE metadata server + Compute API."""
    try:
        import requests as _req
        _meta_headers = {"Metadata-Flavor": "Google"}
        _meta_base = "http://metadata.google.internal/computeMetadata/v1"

        log("Fetching VM metadata for self-deletion...")
        name = _req.get(f"{_meta_base}/instance/name", headers=_meta_headers, timeout=5).text
        zone = _req.get(f"{_meta_base}/instance/zone", headers=_meta_headers, timeout=5).text.split("/")[-1]
        project = _req.get(f"{_meta_base}/project/project-id", headers=_meta_headers, timeout=5).text

        log(f"Deleting VM {name} in {project}/{zone}...")
        from google.cloud import compute_v1
        compute_v1.InstancesClient().delete(project=project, zone=zone, instance=name)
        log(f"VM {name} deletion requested OK")
    except Exception as e:
        log(f"Failed to delete VM: {e}")


# =============================================================================
# STEP 5: Entry point
# =============================================================================
if __name__ == "__main__":
    _exit_code = 1
    try:
        _exit_code = main()
        if _exit_code is None:
            _exit_code = 0
        log(f"main() returned exit_code={_exit_code}")
    except SystemExit as e:
        _exit_code = e.code if e.code is not None else 1
        log(f"main() called sys.exit({_exit_code})")
    except Exception as e:
        log(f"UNHANDLED EXCEPTION: {e}")
        logger.exception("Unhandled exception in __main__")
        _exit_code = 1
    finally:
        log(f"=== Shutting down (exit_code={_exit_code}) ===")
        # Give Cloud Logging 2 seconds to flush before deleting the VM
        sys.stdout.flush()
        sys.stderr.flush()
        time.sleep(2)
        _delete_own_vm()
        log("Goodbye.")
        sys.stdout.flush()
    sys.exit(_exit_code)
