"""
Transcription Pipeline entry point.
Runs on T4 GPU instance, orchestrates Whisper + pyannote + upload.
"""

import argparse
import logging
import sys

from .pipeline import TranscriptionPipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="Transcription Pipeline")
    parser.add_argument("--audio-gcs-path", required=True, help="GCS path to audio file")
    parser.add_argument("--meeting-id", required=True, help="Meeting ID")
    parser.add_argument("--owning-user", required=True, help="Owning user email")
    parser.add_argument("--retry-count", type=int, default=0, help="Current retry count")
    args = parser.parse_args()

    logger.info(
        "Starting transcription pipeline for meeting %s (retry %d)",
        args.meeting_id,
        args.retry_count,
    )

    pipeline = TranscriptionPipeline(
        meeting_id=args.meeting_id,
        audio_gcs_path=args.audio_gcs_path,
        owning_user=args.owning_user,
        retry_count=args.retry_count,
    )

    try:
        pipeline.run()
        logger.info("Pipeline completed successfully for meeting %s", args.meeting_id)
        sys.exit(0)
    except Exception:
        logger.exception("Pipeline failed for meeting %s", args.meeting_id)
        sys.exit(1)


if __name__ == "__main__":
    main()
