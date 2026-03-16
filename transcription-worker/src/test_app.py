"""Tests for the Transcription Worker Flask app."""

import json
import pytest
from unittest.mock import patch, MagicMock

from src.app import app


@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


class TestTriggerTranscription:
    """Tests for POST /internal/trigger-transcription."""

    def test_returns_400_when_missing_event_attributes(self, client):
        resp = client.post(
            "/internal/trigger-transcription",
            json={"message": {"attributes": {}}},
        )
        assert resp.status_code == 400

    def test_returns_400_when_no_meeting_id(self, client):
        resp = client.post(
            "/internal/trigger-transcription",
            json={
                "message": {
                    "attributes": {
                        "bucketId": "leverege-notetaker-audio",
                        "objectId": "",
                    }
                }
            },
        )
        assert resp.status_code == 400

    @patch("src.app.create_transcription_task", return_value=True)
    @patch("src.app.update_meeting_status")
    def test_creates_task_on_valid_event(self, mock_status, mock_task, client):
        resp = client.post(
            "/internal/trigger-transcription",
            json={
                "message": {
                    "attributes": {
                        "bucketId": "leverege-notetaker-audio",
                        "objectId": "abc123/meet-1/audio.wav",
                        "metadata": {
                            "meeting_id": "meet-1",
                            "owning_user": "user@test.com",
                        },
                    }
                }
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "task_created"
        assert data["meetingId"] == "meet-1"
        mock_status.assert_called_once_with("meet-1", "transcription_pending")
        mock_task.assert_called_once()

    @patch("src.app.create_transcription_task", return_value=False)
    @patch("src.app.update_meeting_status")
    def test_returns_200_with_failed_status_when_task_creation_fails(self, mock_status, mock_task, client):
        resp = client.post(
            "/internal/trigger-transcription",
            json={
                "message": {
                    "attributes": {
                        "bucketId": "leverege-notetaker-audio",
                        "objectId": "abc123/meet-2/audio.wav",
                        "metadata": {
                            "meeting_id": "meet-2",
                            "owning_user": "user@test.com",
                        },
                    }
                }
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "task_creation_failed"

    @patch("src.app.create_transcription_task", return_value=True)
    @patch("src.app.update_meeting_status")
    def test_falls_back_to_object_path_for_meeting_id(self, mock_status, mock_task, client):
        resp = client.post(
            "/internal/trigger-transcription",
            json={
                "message": {
                    "attributes": {
                        "bucketId": "leverege-notetaker-audio",
                        "objectId": "userhash/fallback-meet/audio.wav",
                    }
                }
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["meetingId"] == "fallback-meet"


class TestHandleTranscribeTask:
    """Tests for POST /tasks/transcribe."""

    def test_returns_400_when_missing_required_fields(self, client):
        resp = client.post("/tasks/transcribe", json={})
        assert resp.status_code == 400

    @patch("src.app.update_meeting_status")
    def test_marks_failed_when_retry_count_exceeds_max(self, mock_status, client):
        resp = client.post(
            "/tasks/transcribe",
            json={
                "meetingId": "meet-1",
                "audioGcsPath": "gs://bucket/audio.wav",
                "owningUser": "user@test.com",
                "retryCount": 4,
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "max_retries_exceeded"
        mock_status.assert_called_once_with("meet-1", "transcription_failed")

    @patch("src.app.create_gpu_instance", return_value="transcription-meet-1")
    @patch("src.app.update_meeting_status")
    def test_creates_gpu_instance_on_valid_task(self, mock_status, mock_gpu, client):
        resp = client.post(
            "/tasks/transcribe",
            json={
                "meetingId": "meet-1",
                "audioGcsPath": "gs://bucket/audio.wav",
                "owningUser": "user@test.com",
                "retryCount": 0,
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "instance_created"
        assert data["instance"] == "transcription-meet-1"
        mock_status.assert_called_once_with("meet-1", "processing")
        mock_gpu.assert_called_once()

    @patch("src.app.create_gpu_instance", side_effect=Exception("GPU error"))
    @patch("src.app.update_meeting_status")
    def test_returns_500_when_gpu_creation_fails(self, mock_status, mock_gpu, client):
        resp = client.post(
            "/tasks/transcribe",
            json={
                "meetingId": "meet-1",
                "audioGcsPath": "gs://bucket/audio.wav",
                "owningUser": "user@test.com",
                "retryCount": 0,
            },
        )
        assert resp.status_code == 500
        data = resp.get_json()
        assert "error" in data

    @patch("src.app.update_meeting_status")
    def test_retry_count_3_still_processes(self, mock_status, client):
        """retryCount=3 is the 4th attempt (0-indexed), should still process."""
        with patch("src.app.create_gpu_instance", return_value="transcription-meet-1"):
            resp = client.post(
                "/tasks/transcribe",
                json={
                    "meetingId": "meet-1",
                    "audioGcsPath": "gs://bucket/audio.wav",
                    "owningUser": "user@test.com",
                    "retryCount": 3,
                },
            )
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["status"] == "instance_created"
