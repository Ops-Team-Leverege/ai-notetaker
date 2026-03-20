"""
Entry point for the Zoom bot — one-shot script.

LOGGING STRATEGY:
  - log() writes to BOTH stdout AND Cloud Logging
  - Cloud Logging uses write_log_entries() directly (not the handler)
    because the handler batches/buffers and may not flush before VM deletion
  - stdout goes to serial console (lost when VM deletes)
  - Cloud Logging persists after VM deletion
"""

import os
import sys
import logging
import time
import traceback

# =============================================================================
# STEP 1: Basic stdout logging
# =============================================================================
print("[zoom-bot] === Process starting ===", flush=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [zoom-bot] %(levelname)s %(message)s",
    stream=sys.stdout,
    force=True,
)
logger = logging.getLogger("zoom-bot")

# =============================================================================
# STEP 2: Cloud Logging — shared log() function
# =============================================================================
from src.log import log


# =============================================================================
# STEP 3: main() — ALL imports happen here, not at module level
# =============================================================================
def main():
    """Main entry point — reads env vars, validates imports, creates bot, runs it."""
    log("=== main() entered ===")

    # --- Validate imports one by one ---
    log("Importing zoom_meeting_sdk...")
    try:
        import zoom_meeting_sdk as zoom
        log(f"zoom_meeting_sdk OK (version={getattr(zoom, '__version__', 'unknown')})")
    except Exception as e:
        log(f"FATAL: zoom_meeting_sdk import failed: {e}")
        log(traceback.format_exc())
        return 1

    log("Importing GLib...")
    try:
        import gi
        gi.require_version("GLib", "2.0")
        from gi.repository import GLib
        log("GLib OK")
    except Exception as e:
        log(f"FATAL: GLib import failed: {e}")
        log(traceback.format_exc())
        return 1

    log("Importing jwt, requests, secretmanager...")
    try:
        import jwt
        import requests
        from google.cloud import secretmanager
        log("jwt, requests, secretmanager OK")
    except Exception as e:
        log(f"FATAL: dependency import failed: {e}")
        log(traceback.format_exc())
        return 1

    log("--- All imports OK ---")

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
        log(traceback.format_exc())
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
        log(traceback.format_exc())
        return 1

    # --- Run the bot ---
    log("Calling bot.run()...")
    try:
        bot.run()
        log("bot.run() completed normally")
        return 0
    except Exception as e:
        log(f"FATAL: bot.run() crashed: {e}")
        log(traceback.format_exc())
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
        log("=== Entering __main__ ===")
        _exit_code = main()
        if _exit_code is None:
            _exit_code = 0
        log(f"main() returned exit_code={_exit_code}")
    except SystemExit as e:
        _exit_code = e.code if e.code is not None else 1
        log(f"main() called sys.exit({_exit_code})")
    except Exception as e:
        log(f"UNHANDLED EXCEPTION: {e}")
        log(traceback.format_exc())
        _exit_code = 1
    finally:
        log(f"=== Shutting down (exit_code={_exit_code}) ===")
        sys.stdout.flush()
        sys.stderr.flush()
        # Wait 10s for Cloud Logging to flush before deleting VM
        log("Waiting 10s for log flush...")
        time.sleep(10)
        # TEMPORARILY DISABLED: VM self-deletion
        # Keeping VM alive so we can SSH in and debug
        # _delete_own_vm()
        log("Goodbye. (VM self-deletion DISABLED for debugging — delete manually)")
        sys.stdout.flush()
    sys.exit(_exit_code)
