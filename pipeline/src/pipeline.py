"""
TranscriptionPipeline: orchestrates Whisper transcription, pyannote diarization,
segment alignment, and result upload.
"""

import hashlib
import json
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional

from google.cloud import storage

logger = logging.getLogger(__name__)

TRANSCRIPT_BUCKET = os.environ.get("TRANSCRIPT_BUCKET", "leverege-notetaker-transcripts")
AUDIO_BUCKET = os.environ.get("AUDIO_BUCKET", "leverege-notetaker-audio")


@dataclass
class WhisperSegment:
    """A single segment from Whisper output."""
    start: float  # seconds
    end: float
    text: str


@dataclass
class DiarizationSegment:
    """A speaker segment from pyannote."""
    start: float
    end: float
    speaker: str


@dataclass
class TranscriptEntry:
    """Final aligned transcript entry."""
    speaker: str
    text: str
    timestamp: str  # ISO 8601


class TranscriptionPipeline:
    """Orchestrates the full transcription pipeline."""

    def __init__(
        self,
        meeting_id: str,
        audio_gcs_path: str,
        owning_user: str,
        retry_count: int = 0,
    ):
        self.meeting_id = meeting_id
        self.audio_gcs_path = audio_gcs_path
        self.owning_user = owning_user
        self.retry_count = retry_count
        self._local_audio_path: Optional[str] = None
        self._whisper_model = None
        self._diarization_pipeline = None

    def run(self) -> None:
        """Execute the full pipeline: download → transcribe → diarize → align → upload."""
        try:
            # 1. Download audio from GCS
            self._download_audio()

            # 2. Run Whisper transcription
            whisper_segments = self.transcribe()

            # 3. Run pyannote diarization
            diarization_segments = self.diarize()

            # 4. Align segments with speakers
            transcript_entries = self.align(whisper_segments, diarization_segments)

            # 5. Upload transcript to GCS
            self._upload_transcript(transcript_entries)

            # 6. Update meeting status to completed
            self._update_status("completed")

            # 7. Delete source audio
            self._delete_audio()

        finally:
            # Cleanup local temp file
            if self._local_audio_path and os.path.exists(self._local_audio_path):
                os.remove(self._local_audio_path)

    def _download_audio(self) -> None:
        """Download audio file from GCS to local temp file."""
        logger.info("Downloading audio from %s", self.audio_gcs_path)

        # Parse GCS path: gs://bucket/path/to/file
        path = self.audio_gcs_path.replace("gs://", "")
        bucket_name = path.split("/")[0]
        blob_path = "/".join(path.split("/")[1:])

        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_path)

        # Create temp file with same extension
        ext = os.path.splitext(blob_path)[1] or ".wav"
        fd, self._local_audio_path = tempfile.mkstemp(suffix=ext)
        os.close(fd)

        blob.download_to_filename(self._local_audio_path)
        logger.info("Downloaded audio to %s", self._local_audio_path)

    def transcribe(self) -> List[WhisperSegment]:
        """
        Run Whisper transcription on the audio file.
        Returns list of WhisperSegment with timestamps.
        Audio never leaves GCP - processed entirely on this instance.
        """
        import whisper

        logger.info("Loading Whisper model...")
        if self._whisper_model is None:
            self._whisper_model = whisper.load_model("base")

        logger.info("Transcribing audio...")
        result = self._whisper_model.transcribe(
            self._local_audio_path,
            language="en",
            verbose=False,
        )

        segments = []
        for seg in result.get("segments", []):
            segments.append(
                WhisperSegment(
                    start=seg["start"],
                    end=seg["end"],
                    text=seg["text"].strip(),
                )
            )

        logger.info("Transcription complete: %d segments", len(segments))
        return segments

    def diarize(self) -> List[DiarizationSegment]:
        """
        Run pyannote speaker diarization on the audio file.
        Returns list of DiarizationSegment with speaker labels.
        """
        from pyannote.audio import Pipeline

        logger.info("Loading pyannote diarization pipeline...")
        if self._diarization_pipeline is None:
            # Use pretrained pipeline - requires HF token in env
            self._diarization_pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=os.environ.get("HF_TOKEN"),
            )

        logger.info("Running speaker diarization...")
        diarization = self._diarization_pipeline(self._local_audio_path)

        segments = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append(
                DiarizationSegment(
                    start=turn.start,
                    end=turn.end,
                    speaker=speaker,
                )
            )

        logger.info("Diarization complete: %d speaker segments", len(segments))
        return segments


    def align(
        self,
        whisper_segments: List[WhisperSegment],
        diarization_segments: List[DiarizationSegment],
    ) -> List[TranscriptEntry]:
        """
        Align Whisper segments with pyannote speaker segments.
        Every Whisper segment is assigned exactly one speaker label.
        Returns TranscriptEntry list ordered chronologically.
        """
        logger.info("Aligning %d whisper segments with %d speaker segments",
                    len(whisper_segments), len(diarization_segments))

        entries = []
        for wseg in whisper_segments:
            # Find the speaker segment with maximum overlap
            speaker = self._find_speaker(wseg, diarization_segments)

            # Convert start time to ISO 8601 timestamp
            # Using a reference time of epoch for relative timestamps
            timestamp = datetime.fromtimestamp(wseg.start, tz=timezone.utc).isoformat()

            entries.append(
                TranscriptEntry(
                    speaker=speaker,
                    text=wseg.text,
                    timestamp=timestamp,
                )
            )

        # Already chronologically ordered from Whisper
        logger.info("Alignment complete: %d transcript entries", len(entries))
        return entries

    def _find_speaker(
        self,
        wseg: WhisperSegment,
        diarization_segments: List[DiarizationSegment],
    ) -> str:
        """Find the speaker with maximum overlap for a Whisper segment."""
        if not diarization_segments:
            return "SPEAKER_00"

        best_speaker = "SPEAKER_00"
        best_overlap = 0.0

        for dseg in diarization_segments:
            # Calculate overlap
            overlap_start = max(wseg.start, dseg.start)
            overlap_end = min(wseg.end, dseg.end)
            overlap = max(0.0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = dseg.speaker

        return best_speaker

    def _upload_transcript(self, entries: List[TranscriptEntry]) -> None:
        """Upload transcript JSON to GCS."""
        # Build transcript JSON
        transcript_data = [
            {"speaker": e.speaker, "text": e.text, "timestamp": e.timestamp}
            for e in entries
        ]

        # Path: gs://transcripts/{owning_user_hash}/{meeting_id}/transcript.json
        user_hash = hashlib.sha256(self.owning_user.encode()).hexdigest()[:16]
        blob_path = f"{user_hash}/{self.meeting_id}/transcript.json"

        logger.info("Uploading transcript to gs://%s/%s", TRANSCRIPT_BUCKET, blob_path)

        client = storage.Client()
        bucket = client.bucket(TRANSCRIPT_BUCKET)
        blob = bucket.blob(blob_path)
        blob.upload_from_string(
            json.dumps(transcript_data, indent=2),
            content_type="application/json",
        )

        logger.info("Transcript uploaded successfully")


    def _update_status(self, status: str) -> None:
        """Update meeting status in Cloud SQL."""
        import pg8000
        from urllib.parse import urlparse

        database_url = os.environ.get("DATABASE_URL", "")
        if not database_url:
            logger.warning("DATABASE_URL not set, skipping status update")
            return

        parsed = urlparse(database_url)
        conn = pg8000.connect(
            host=parsed.hostname or "localhost",
            port=parsed.port or 5432,
            user=parsed.username or "postgres",
            password=parsed.password or "",
            database=parsed.path.lstrip("/") or "notetaker",
        )

        try:
            cursor = conn.cursor()
            # Also set transcript_location
            user_hash = hashlib.sha256(self.owning_user.encode()).hexdigest()[:16]
            transcript_location = f"gs://{TRANSCRIPT_BUCKET}/{user_hash}/{self.meeting_id}/transcript.json"

            cursor.execute(
                """UPDATE meetings 
                   SET transcription_status = %s, 
                       transcript_location = %s,
                       updated_at = NOW() 
                   WHERE meeting_id = %s""",
                (status, transcript_location, self.meeting_id),
            )
            conn.commit()
            logger.info("Updated meeting %s status to %s", self.meeting_id, status)
        finally:
            conn.close()

    def _delete_audio(self) -> None:
        """Delete source audio from GCS after successful transcription."""
        logger.info("Deleting source audio from %s", self.audio_gcs_path)

        path = self.audio_gcs_path.replace("gs://", "")
        bucket_name = path.split("/")[0]
        blob_path = "/".join(path.split("/")[1:])

        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_path)

        # Retry deletion up to 3 times
        for attempt in range(3):
            try:
                blob.delete()
                logger.info("Source audio deleted successfully")
                return
            except Exception:
                logger.exception("Failed to delete audio (attempt %d/3)", attempt + 1)
                if attempt == 2:
                    # Final failure - log alert for operator
                    logger.error(
                        "ALERT: Failed to delete audio after 3 attempts: %s",
                        self.audio_gcs_path,
                    )
