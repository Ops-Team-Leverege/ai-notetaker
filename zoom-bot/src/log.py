"""
Shared logging for zoom-bot — writes to BOTH stdout AND Cloud Logging.

Cloud Logging uses the direct API (log_text) not the handler, because
the handler batches/buffers and may not flush before VM self-deletion.
"""

import sys

_cloud_logger = None

try:
    import google.cloud.logging as gcl
    _logging_client = gcl.Client()
    _cloud_logger = _logging_client.logger("zoom-bot")
except Exception:
    pass


def log(msg):
    """Log to both stdout and Cloud Logging (direct API)."""
    print(f"[zoom-bot] {msg}", flush=True)
    if _cloud_logger:
        try:
            _cloud_logger.log_text(f"[zoom-bot] {msg}", severity="INFO")
        except Exception:
            pass
