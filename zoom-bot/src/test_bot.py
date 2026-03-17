"""Tests for the Zoom bot — pure functions and Flask app endpoints."""

import io
import json
import struct
import wave
from unittest.mock import MagicMock, patch

import pytest

from src.bot import generate_sdk_jwt, hash_user_email, pcm_to_wav


class TestGenerateSdkJwt:
    def test_returns_valid_jwt(self):
        token = generate_sdk_jwt("test-client-id", "test-secret")
        assert isinstance(token, str)
        assert len(token.split(".")) == 3  # header.payload.signature

    def test_jwt_contains_app_key(self):
        import jwt as pyjwt
        token = generate_sdk_jwt("my-app-key", "my-secret")
        decoded = pyjwt.decode(token, "my-secret", algorithms=["HS256"])
        assert decoded["appKey"] == "my-app-key"
        assert "iat" in decoded
        assert "exp" in decoded
        assert "tokenExp" in decoded

    def test_different_secrets_produce_different_tokens(self):
        t1 = generate_sdk_jwt("id", "secret-a")
        t2 = generate_sdk_jwt("id", "secret-b")
        assert t1 != t2


class TestHashUserEmail:
    def test_deterministic(self):
        h1 = hash_user_email("user@example.com")
        h2 = hash_user_email("user@example.com")
        assert h1 == h2

    def test_different_emails_different_hashes(self):
        h1 = hash_user_email("alice@example.com")
        h2 = hash_user_email("bob@example.com")
        assert h1 != h2

    def test_returns_hex_string(self):
        h = hash_user_email("test@test.com")
        assert len(h) == 64  # SHA-256 hex
        int(h, 16)  # Should not raise


class TestPcmToWav:
    def test_produces_valid_wav(self):
        # Generate 1 second of silence at 32kHz 16-bit mono
        num_samples = 32000
        pcm = struct.pack(f"<{num_samples}h", *([0] * num_samples))
        wav_data = pcm_to_wav(pcm, sample_rate=32000)

        # Parse the WAV header
        buf = io.BytesIO(wav_data)
        with wave.open(buf, "rb") as wf:
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2
            assert wf.getframerate() == 32000
            assert wf.getnframes() == num_samples

    def test_empty_pcm(self):
        wav_data = pcm_to_wav(b"")
        buf = io.BytesIO(wav_data)
        with wave.open(buf, "rb") as wf:
            assert wf.getnframes() == 0

    def test_preserves_audio_data(self):
        # Create known PCM data
        samples = [100, -200, 300, -400]
        pcm = struct.pack(f"<{len(samples)}h", *samples)
        wav_data = pcm_to_wav(pcm, sample_rate=16000)

        buf = io.BytesIO(wav_data)
        with wave.open(buf, "rb") as wf:
            frames = wf.readframes(wf.getnframes())
            recovered = struct.unpack(f"<{len(samples)}h", frames)
            assert list(recovered) == samples


class TestFlaskApp:
    @pytest.fixture
    def client(self):
        from src.app import app
        app.config["TESTING"] = True
        with app.test_client() as c:
            yield c

    def test_health(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.get_json()["status"] == "ok"

    def test_join_missing_fields(self, client):
        resp = client.post("/join", json={"meetingId": "abc"})
        assert resp.status_code == 400

    @patch("src.app.subprocess.Popen")
    def test_join_success(self, mock_popen, client):
        mock_proc = MagicMock()
        mock_proc.pid = 12345
        mock_proc.poll.return_value = None
        mock_popen.return_value = mock_proc

        resp = client.post("/join", json={
            "meetingId": "uuid-123",
            "meetingNumber": 1234567890,
            "passcode": "abc",
            "owningUser": "user@example.com",
        })
        assert resp.status_code == 202
        data = resp.get_json()
        assert data["status"] == "started"
        assert data["pid"] == 12345

    @patch("src.app.subprocess.Popen")
    def test_join_conflict_when_bot_active(self, mock_popen, client):
        mock_proc = MagicMock()
        mock_proc.pid = 111
        mock_proc.poll.return_value = None  # Still running
        mock_popen.return_value = mock_proc

        # First join
        client.post("/join", json={
            "meetingId": "uuid-1",
            "meetingNumber": 111,
            "passcode": "x",
            "owningUser": "a@b.com",
        })

        # Second join should conflict
        resp = client.post("/join", json={
            "meetingId": "uuid-2",
            "meetingNumber": 222,
            "passcode": "y",
            "owningUser": "c@d.com",
        })
        assert resp.status_code == 409
