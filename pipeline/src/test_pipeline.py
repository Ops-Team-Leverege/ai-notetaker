"""Tests for the Transcription Pipeline."""

import json
import pytest
from unittest.mock import patch, MagicMock, mock_open
from datetime import datetime, timezone

from src.pipeline import (
    TranscriptionPipeline,
    WhisperSegment,
    DiarizationSegment,
    TranscriptEntry,
)


class TestAlign:
    """Tests for segment-speaker alignment."""

    def test_aligns_segments_with_speakers(self):
        pipeline = TranscriptionPipeline(
            meeting_id="test-1",
            audio_gcs_path="gs://bucket/audio.wav",
            owning_user="user@test.com",
        )

        whisper_segments = [
            WhisperSegment(start=0.0, end=2.0, text="Hello there"),
            WhisperSegment(start=2.5, end=4.0, text="How are you"),
        ]

        diarization_segments = [
            DiarizationSegment(start=0.0, end=2.5, speaker="SPEAKER_00"),
            DiarizationSegment(start=2.5, end=5.0, speaker="SPEAKER_01"),
        ]

        entries = pipeline.align(whisper_segments, diarization_segments)

        assert len(entries) == 2
        assert entries[0].speaker == "SPEAKER_00"
        assert entries[0].text == "Hello there"
        assert entries[1].speaker == "SPEAKER_01"
        assert entries[1].text == "How are you"

    def test_assigns_default_speaker_when_no_diarization(self):
        pipeline = TranscriptionPipeline(
            meeting_id="test-2",
            audio_gcs_path="gs://bucket/audio.wav",
            owning_user="user@test.com",
        )

        whisper_segments = [
            WhisperSegment(start=0.0, end=2.0, text="Hello"),
        ]

        entries = pipeline.align(whisper_segments, [])

        assert len(entries) == 1
        assert entries[0].speaker == "SPEAKER_00"

    def test_all_segments_get_speaker_label(self):
        """Every Whisper segment must be assigned exactly one speaker."""
        pipeline = TranscriptionPipeline(
            meeting_id="test-3",
            audio_gcs_path="gs://bucket/audio.wav",
            owning_user="user@test.com",
        )

        whisper_segments = [
            WhisperSegment(start=i * 2.0, end=(i + 1) * 2.0, text=f"Segment {i}")
            for i in range(10)
        ]

        diarization_segments = [
            DiarizationSegment(start=0.0, end=10.0, speaker="SPEAKER_00"),
            DiarizationSegment(start=10.0, end=20.0, speaker="SPEAKER_01"),
        ]

        entries = pipeline.align(whisper_segments, diarization_segments)

        assert len(entries) == 10
        for entry in entries:
            assert entry.speaker in ("SPEAKER_00", "SPEAKER_01")
            assert len(entry.text) > 0
            assert len(entry.timestamp) > 0

    def test_entries_are_chronologically_ordered(self):
        pipeline = TranscriptionPipeline(
            meeting_id="test-4",
            audio_gcs_path="gs://bucket/audio.wav",
            owning_user="user@test.com",
        )

        whisper_segments = [
            WhisperSegment(start=0.0, end=1.0, text="First"),
            WhisperSegment(start=1.0, end=2.0, text="Second"),
            WhisperSegment(start=2.0, end=3.0, text="Third"),
        ]

        entries = pipeline.align(whisper_segments, [])

        timestamps = [datetime.fromisoformat(e.timestamp) for e in entries]
        assert timestamps == sorted(timestamps)


class TestFindSpeaker:
    """Tests for speaker matching logic."""

    def test_finds_speaker_with_maximum_overlap(self):
        pipeline = TranscriptionPipeline(
            meeting_id="test-5",
            audio_gcs_path="gs://bucket/audio.wav",
            owning_user="user@test.com",
        )

        wseg = WhisperSegment(start=1.0, end=3.0, text="Test")

        diarization_segments = [
            DiarizationSegment(start=0.0, end=1.5, speaker="SPEAKER_00"),  # 0.5s overlap
            DiarizationSegment(start=1.5, end=4.0, speaker="SPEAKER_01"),  # 1.5s overlap
        ]

        speaker = pipeline._find_speaker(wseg, diarization_segments)
        assert speaker == "SPEAKER_01"

    def test_returns_default_when_no_overlap(self):
        pipeline = TranscriptionPipeline(
            meeting_id="test-6",
            audio_gcs_path="gs://bucket/audio.wav",
            owning_user="user@test.com",
        )

        wseg = WhisperSegment(start=10.0, end=12.0, text="Test")

        diarization_segments = [
            DiarizationSegment(start=0.0, end=5.0, speaker="SPEAKER_00"),
        ]

        speaker = pipeline._find_speaker(wseg, diarization_segments)
        assert speaker == "SPEAKER_00"  # Falls back to first/default


class TestTranscriptEntrySchema:
    """Tests for transcript entry schema validity."""

    def test_entry_has_required_fields(self):
        entry = TranscriptEntry(
            speaker="SPEAKER_00",
            text="Hello world",
            timestamp="2024-01-01T00:00:00+00:00",
        )

        assert hasattr(entry, "speaker")
        assert hasattr(entry, "text")
        assert hasattr(entry, "timestamp")

    def test_timestamp_is_iso8601(self):
        pipeline = TranscriptionPipeline(
            meeting_id="test-7",
            audio_gcs_path="gs://bucket/audio.wav",
            owning_user="user@test.com",
        )

        whisper_segments = [WhisperSegment(start=0.0, end=1.0, text="Test")]
        entries = pipeline.align(whisper_segments, [])

        # Should parse without error
        dt = datetime.fromisoformat(entries[0].timestamp)
        assert dt.tzinfo is not None  # Should have timezone


class TestPipelineErrorHandling:
    """Tests for pipeline error handling."""

    @patch("src.pipeline.storage.Client")
    def test_audio_deletion_retries_three_times(self, mock_storage):
        pipeline = TranscriptionPipeline(
            meeting_id="test-8",
            audio_gcs_path="gs://bucket/path/audio.wav",
            owning_user="user@test.com",
        )

        mock_bucket = MagicMock()
        mock_blob = MagicMock()
        mock_blob.delete.side_effect = Exception("Delete failed")
        mock_bucket.blob.return_value = mock_blob
        mock_storage.return_value.bucket.return_value = mock_bucket

        # Should not raise, but log error
        pipeline._delete_audio()

        assert mock_blob.delete.call_count == 3
