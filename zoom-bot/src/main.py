"""
Entry point for the Zoom bot — one-shot script.

Reads meeting details from environment variables, joins the meeting,
records audio, uploads to GCS, enqueues transcription, then exits.

CRITICAL: All diagnostic output uses print(flush=True) to stdout.
logger.info() is also used but Cloud Logging may swallow those.
The print() calls are the ground truth for debugging via serial console.
"""

import os
import sys
import logging
import traceback

# =============================================================================
# STEP 1: STDOUT LOGGING — before ANY other imports
# =============================================================================
print("[zoom-bot] === Process starting ===", flush=True)
print(f"[zoom-bot] Python {sys.version}", flush=True)
print(f"[zoom-bot] PYTHONUNBUFFERED={os.environ.get('PYTHONUNBUFFERED', 'not set')}", flush=True)

_stdout_handler = logging.StreamHandler(sys.stdout)
_stdout_handler.setFormatter(logging.Formatter("%(asctime)s [zoom-bot] %(levelname)s %(message)s"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [zoom-bot] %(levelname)s %(message)s",
    stream=sys.stdout,
    force=True,
)
logger = logging.getLogger("zoom-bot")
logger.info("Logger initialized")

# =============================================================================
# STEP 2: Cloud Logging (non-fatal). Re-add stdout handler after setup.
# =============================================================================
print("[zoom-bot] Setting up Cloud Logging...", flush=True)
try:
    import google.cloud.logging as gcl
    _logging_client = gcl.Client()
    _logging_client.setup_logging(log_level=logging.INFO)
    # Cloud Logging's setup_logging() replaces all handlers — re-add stdout
    logging.getLogger().addHandler(_stdout_handler)
    logger.addHandler(_stdout_handler)
    print("[zoom-bot] Cloud Logging OK (stdout handler re-added)", flush=True)
except Exception as e:
    print(f"[zoom-bot] Cloud Logging not available: {e}", flush=True)

sys.stdout.flush()


# =============================================================================
# STEP 3: Validate critical imports one by one
# =============================================================================
print("[zoom-bot] --- Import validation ---", flush=True)

print("[zoom-bot] Importing zoom_meeting_sdk...", flush=True)
try:
    import zoom_meeting_sdk as zoom
    print(f"[zoom-bot] zoom_meeting_sdk OK (version={getattr(zoom, '__version__', 'unknown')})", flush=True)
except Exception as e:
    print(f"[zoom-bot] FATAL: zoom_meeting_sdk import failed: {e}", flush=True)
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()
    sys.exit(1)

print("[zoom-bot] Importing GLib...", flush=True)
try:
    import gi
    gi.require_version("GLib", "2.0")
    from gi.repository import GLib
    print("[zoom-bot] GLib OK", flush=True)
except Exception as e:
    print(f"[zoom-bot] FATAL: GLib import failed: {e}", flush=True)
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()
    sys.exit(1)

print("[zoom-bot] Importing jwt, requests, secretmanager...", flush=True)
try:
    import jwt
    import requests
    from google.cloud import secretmanager
    print("[zoom-bot] jwt, requests, secretmanager OK", flush=True)
except Exception as e:
    print(f"[zoom-bot] FATAL: dependency import failed: {e}", flush=True)
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()
    sys.exit(1)

print("[zoom-bot] --- All imports OK ---", flush=True)
sys.stdout.flush()


# =============================================================================
# STEP 4: main() — the actual bot logic
# =============================================================================
def main():
    """Main entry point — reads env vars, creates bot, runs it."""
    print("[zoom-bot] === main() entered ===", flush=True)
    logger.info("=== zoom-bot main() starting ===")

    # --- Read env vars ---
    print("[zoom-bot] Reading environment variables...", flush=True)
    meeting_id = os.environ.get("BOT_MEETING_ID")
    meeting_number_str = os.environ.get("BOT_MEETING_NUMBER")
    passcode = os.environ.get("BOT_PASSCODE")
    owning_user = os.environ.get("BOT_OWNING_USER")
    display_name = os.environ.get("BOT_DISPLAY_NAME", "Leverege Notetaker")

    print(f"[zoom-bot] BOT_MEETING_ID={meeting_id}", flush=True)
    print(f"[zoom-bot] BOT_MEETING_NUMBER={meeting_number_str}", flush=True)
    print(f"[zoom-bot] BOT_PASSCODE={'(set)' if passcode else '(NOT SET)'}", flush=True)
    print(f"[zoom-bot] BOT_OWNING_USER={owning_user}", flush=True)
    print(f"[zoom-bot] BOT_DISPLAY_NAME={display_name}", flush=True)
    sys.stdout.flush()

    if not meeting_id:
        print("[zoom-bot] FATAL: BOT_MEETING_ID is not set", flush=True)
        return 1
    if not meeting_number_str:
        print("[zoom-bot] FATAL: BOT_MEETING_NUMBER is not set", flush=True)
        return 1
    if not passcode:
        print("[zoom-bot] FATAL: BOT_PASSCODE is not set", flush=True)
        return 1
    if not owning_user:
        print("[zoom-bot] FATAL: BOT_OWNING_USER is not set", flush=True)
        return 1

    try:
        meeting_number = int(meeting_number_str)
    except ValueError:
        print(f"[zoom-bot] FATAL: BOT_MEETING_NUMBER is not a valid integer: {meeting_number_str}", flush=True)
        return 1

    print(f"[zoom-bot] All env vars OK. Meeting {meeting_number} for {owning_user}", flush=True)

    # --- Import and create bot ---
    print("[zoom-bot] Importing ZoomMeetingBot from src.bot...", flush=True)
    try:
        from src.bot import ZoomMeetingBot
        print("[zoom-bot] ZoomMeetingBot imported OK", flush=True)
    except Exception as e:
        print(f"[zoom-bot] FATAL: Failed to import ZoomMeetingBot: {e}", flush=True)
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()
        return 1

    print("[zoom-bot] Creating ZoomMeetingBot instance...", flush=True)
    try:
        bot = ZoomMeetingBot(
            meeting_id=meeting_id,
            meeting_number=meeting_number,
            passcode=passcode,
            owning_user=owning_user,
            display_name=display_name,
        )
        print("[zoom-bot] Bot instance created OK", flush=True)
    except Exception as e:
        print(f"[zoom-bot] FATAL: Failed to create bot: {e}", flush=True)
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()
        return 1

    # --- Run the bot ---
    print("[zoom-bot] Calling bot.run()...", flush=True)
    sys.stdout.flush()
    try:
        bot.run()
        print("[zoom-bot] bot.run() completed normally", flush=True)
        return 0
    except Exception as e:
        print(f"[zoom-bot] FATAL: bot.run() crashed: {e}", flush=True)
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()
        return 1


# =============================================================================
# STEP 5: VM self-deletion
# =============================================================================
def _delete_own_vm():
    """Delete this VM via the GCE metadata server + Compute API."""
    try:
        import requests as _req
        _meta_headers = {"Metadata-Flavor": "Google"}
        _meta_base = "http://metadata.google.internal/computeMetadata/v1"

        print("[zoom-bot] Fetching VM metadata for self-deletion...", flush=True)
        name = _req.get(f"{_meta_base}/instance/name", headers=_meta_headers, timeout=5).text
        zone = _req.get(f"{_meta_base}/instance/zone", headers=_meta_headers, timeout=5).text.split("/")[-1]
        project = _req.get(f"{_meta_base}/project/project-id", headers=_meta_headers, timeout=5).text

        print(f"[zoom-bot] Deleting VM {name} in {project}/{zone}...", flush=True)
        from google.cloud import compute_v1
        compute_v1.InstancesClient().delete(project=project, zone=zone, instance=name)
        print(f"[zoom-bot] VM {name} deletion requested OK", flush=True)
    except Exception as e:
        print(f"[zoom-bot] Failed to delete VM: {e}", flush=True)


# =============================================================================
# STEP 6: Entry point
# =============================================================================
if __name__ == "__main__":
    _exit_code = 1
    try:
        print("[zoom-bot] === Entering __main__ ===", flush=True)
        _exit_code = main()
        if _exit_code is None:
            _exit_code = 0
        print(f"[zoom-bot] main() returned exit_code={_exit_code}", flush=True)
    except SystemExit as e:
        _exit_code = e.code if e.code is not None else 1
        print(f"[zoom-bot] main() called sys.exit({_exit_code})", flush=True)
    except Exception as e:
        print(f"[zoom-bot] UNHANDLED EXCEPTION in __main__: {e}", flush=True)
        traceback.print_exc(file=sys.stdout)
        _exit_code = 1
    finally:
        print(f"[zoom-bot] === Shutting down (exit_code={_exit_code}) ===", flush=True)
        sys.stdout.flush()
        _delete_own_vm()
        print("[zoom-bot] Goodbye.", flush=True)
        sys.stdout.flush()
        sys.stderr.flush()
    sys.exit(_exit_code)
