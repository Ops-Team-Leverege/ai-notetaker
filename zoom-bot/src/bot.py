"""
Zoom Meeting Bot — joins meetings via the Zoom Meeting SDK and captures raw audio.

Uses zoom-meeting-sdk Python bindings (https://pypi.org/project/zoom-meeting-sdk/).
Runs inside Docker with PulseAudio virtual sink for headless audio.

Flow:
  1. Fetch SDK credentials from Secret Manager (zoom-sdk-credentials)
  2. Fetch S2S OAuth credentials from Secret Manager (zoom-account-credentials)
  3. Get S2S access token → fetch ZAK token for meeting join
  4. Generate JWT for SDK auth using SDK credentials
  5. Join meeting by number + passcode + ZAK token
  6. Subscribe to raw audio data callback
  7. Accumulate PCM frames → WAV on meeting end
  8. Upload WAV to GCS
  9. Enqueue Cloud Tasks transcription job
  10. Exit
"""

import os
import io
import sys
import wave
import array
import hashlib
import json
import logging
import signal
import time
from datetime import datetime, timedelta
from typing import Optional

import jwt
import requests

logger = logging.getLogger("zoom-bot")
logger.setLevel(logging.INFO)

# Ensure stdout handler exists (main.py sets this up, but be safe for direct imports)
if not any(isinstance(h, logging.StreamHandler) for h in logger.handlers):
    _stdout_handler = logging.StreamHandler(sys.stdout)
    _stdout_handler.setFormatter(logging.Formatter("%(asctime)s [zoom-bot] %(levelname)s %(message)s"))
    logger.addHandler(_stdout_handler)

# SDK sample rate — the SDK delivers 32kHz mono PCM by default
SDK_SAMPLE_RATE = 32000
SDK_SAMPLE_WIDTH = 2  # 16-bit PCM
SDK_CHANNELS = 1

PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "ai-meeting-notetaker-490206")
REGION = os.environ.get("GCP_REGION", "us-central1")
AUDIO_BUCKET = os.environ.get("AUDIO_BUCKET", "leverege-notetaker-audio")
QUEUE_NAME = os.environ.get("TRANSCRIPTION_QUEUE", "transcription-queue")
WORKER_URL = os.environ.get("TRANSCRIPTION_WORKER_URL", "")


def generate_sdk_jwt(client_id: str, client_secret: str) -> str:
    """Generate a JWT token for Zoom Meeting SDK authentication."""
    iat = datetime.utcnow()
    exp = iat + timedelta(hours=24)
    payload = {
        "iat": iat,
        "exp": exp,
        "appKey": client_id,
        "tokenExp": int(exp.timestamp()),
    }
    return jwt.encode(payload, client_secret, algorithm="HS256")


def hash_user_email(email: str) -> str:
    """SHA-256 hash of email for GCS path scoping."""
    return hashlib.sha256(email.encode()).hexdigest()


def pcm_to_wav(pcm_data: bytes, sample_rate: int = SDK_SAMPLE_RATE) -> bytes:
    """Convert raw PCM bytes to WAV format in memory."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(SDK_CHANNELS)
        wf.setsampwidth(SDK_SAMPLE_WIDTH)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


def fetch_sdk_credentials() -> dict:
    """Fetch Meeting SDK credentials from Secret Manager (zoom-sdk-credentials).

    Returns {"client_id":"...","client_secret":"..."} from the General App.
    Used to initialize and authenticate the Zoom Meeting SDK.
    """
    from google.cloud import secretmanager
    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{PROJECT_ID}/secrets/zoom-sdk-credentials/versions/latest"
    response = client.access_secret_version(request={"name": name})
    return json.loads(response.payload.data.decode("utf-8"))


def fetch_s2s_credentials() -> dict:
    """Fetch S2S OAuth credentials from Secret Manager (zoom-account-credentials).

    Returns {"account_id":"...","client_id":"...","client_secret":"..."} from the S2S OAuth App.
    Used to obtain access tokens for the Zoom REST API (ZAK token fetch).
    """
    from google.cloud import secretmanager
    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{PROJECT_ID}/secrets/zoom-account-credentials/versions/latest"
    response = client.access_secret_version(request={"name": name})
    return json.loads(response.payload.data.decode("utf-8"))


def get_s2s_access_token(creds: dict) -> str:
    """Get a Zoom S2S OAuth access token using account_credentials grant."""
    basic_auth = (creds["client_id"], creds["client_secret"])
    resp = requests.post(
        "https://zoom.us/oauth/token",
        auth=basic_auth,
        data={
            "grant_type": "account_credentials",
            "account_id": creds["account_id"],
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def fetch_zak_token(access_token: str) -> str:
    """Fetch a ZAK token for the authenticated user (ai-notetaker@leverege.com).

    The ZAK token is required since Feb 23, 2026 for Zoom OBF compliance.
    It expires after 90 minutes — fetch a fresh one per meeting join.
    """
    resp = requests.get(
        "https://api.zoom.us/v2/users/me/token",
        params={"type": "zak"},
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["token"]


def upload_wav_to_gcs(wav_data: bytes, meeting_id: str, owning_user: str) -> str:
    """Upload WAV audio to GCS and return the gs:// URI."""
    from google.cloud import storage
    user_hash = hash_user_email(owning_user)
    gcs_path = f"{user_hash}/{meeting_id}/audio.wav"
    client = storage.Client()
    bucket = client.bucket(AUDIO_BUCKET)
    blob = bucket.blob(gcs_path)
    blob.upload_from_string(wav_data, content_type="audio/wav")
    uri = f"gs://{AUDIO_BUCKET}/{gcs_path}"
    logger.info("Uploaded audio to %s", uri)
    return uri


def enqueue_transcription(meeting_id: str, audio_gcs_path: str, owning_user: str) -> None:
    """Create a Cloud Tasks entry to trigger the transcription worker."""
    from google.cloud import tasks_v2
    client = tasks_v2.CloudTasksClient()
    parent = client.queue_path(PROJECT_ID, REGION, QUEUE_NAME)
    payload = json.dumps({
        "meetingId": meeting_id,
        "audioGcsPath": audio_gcs_path,
        "owningUser": owning_user,
        "retryCount": 0,
    })
    client.create_task(request={
        "parent": parent,
        "task": {
            "http_request": {
                "http_method": tasks_v2.HttpMethod.POST,
                "url": WORKER_URL,
                "headers": {"Content-Type": "application/json"},
                "body": payload.encode(),
            }
        },
    })
    logger.info("Enqueued transcription task for meeting %s", meeting_id)


class ZoomMeetingBot:
    """
    Joins a Zoom meeting via the Meeting SDK, captures raw audio,
    and uploads the recording when the meeting ends.
    """

    def __init__(self, meeting_id: str, meeting_number: int, passcode: str,
                 owning_user: str, display_name: str = "Leverege Notetaker"):
        self.meeting_id = meeting_id          # Our internal UUID
        self.meeting_number = meeting_number  # Zoom numeric meeting ID
        self.passcode = passcode
        self.owning_user = owning_user
        self.display_name = display_name

        # SDK objects (set during init)
        self._meeting_service = None
        self._auth_service = None
        self._setting_service = None
        self._recording_ctrl = None
        self._audio_helper = None
        self._audio_source = None
        self._participants_ctrl = None
        self._my_participant_id = None

        # Audio accumulator
        self._pcm_chunks: list[bytes] = []
        self._is_recording = False
        self._meeting_ended = False
        self._zak_token: Optional[str] = None

        # GLib main loop
        self._main_loop = None
        self._shutdown_requested = False

    def run(self) -> None:
        """Main entry point — blocks until meeting ends."""
        import gi
        gi.require_version("GLib", "2.0")
        from gi.repository import GLib

        logger.info("Bot.run() starting for meeting_id=%s meeting_number=%d user=%s",
                     self.meeting_id, self.meeting_number, self.owning_user)

        # Fetch credentials from two separate secrets
        try:
            logger.info("Fetching SDK credentials from zoom-sdk-credentials...")
            sdk_creds = fetch_sdk_credentials()
            logger.info("SDK credentials fetched (client_id=%s...)", sdk_creds.get("client_id", "?")[:8])
        except Exception:
            logger.exception("Failed to fetch SDK credentials")
            raise

        try:
            logger.info("Fetching S2S OAuth credentials from zoom-account-credentials...")
            s2s_creds = fetch_s2s_credentials()
            logger.info("S2S credentials fetched (account_id=%s...)", s2s_creds.get("account_id", "?")[:8])
        except Exception:
            logger.exception("Failed to fetch S2S credentials")
            raise

        try:
            logger.info("Getting S2S access token...")
            access_token = get_s2s_access_token(s2s_creds)
            logger.info("S2S access token obtained (length=%d)", len(access_token))
        except Exception:
            logger.exception("Failed to get S2S access token")
            raise

        try:
            logger.info("Fetching ZAK token...")
            self._zak_token = fetch_zak_token(access_token)
            logger.info("ZAK token fetched (length=%d)", len(self._zak_token))
        except Exception:
            logger.exception("Failed to fetch ZAK token")
            raise

        try:
            logger.info("Initializing Zoom Meeting SDK...")
            self._init_sdk(sdk_creds)
            logger.info("SDK initialized successfully")
        except Exception:
            logger.exception("Failed to initialize SDK")
            raise

        # Set up signal handlers for clean shutdown
        signal.signal(signal.SIGINT, self._on_signal)
        signal.signal(signal.SIGTERM, self._on_signal)

        # Run GLib main loop (SDK events are dispatched here)
        self._main_loop = GLib.MainLoop()
        GLib.timeout_add(100, self._check_shutdown)

        try:
            logger.info("Starting GLib main loop")
            self._main_loop.run()
        except Exception as e:
            logger.error("Main loop error: %s", e)
        finally:
            self._finalize()

    def _init_sdk(self, creds: dict) -> None:
        """Initialize the Zoom Meeting SDK, authenticate, and join."""
        import zoom_meeting_sdk as zoom

        init_param = zoom.InitParam()
        init_param.strWebDomain = "https://zoom.us"
        init_param.strSupportUrl = "https://zoom.us"
        init_param.enableGenerateDump = True
        init_param.emLanguageID = zoom.SDK_LANGUAGE_ID.LANGUAGE_English
        init_param.enableLogByDefault = True

        logger.info("Calling zoom.InitSDK()...")
        result = zoom.InitSDK(init_param)
        if result != zoom.SDKERR_SUCCESS:
            raise RuntimeError(f"InitSDK failed: {result}")
        logger.info("InitSDK succeeded")

        # Create services
        self._meeting_service = zoom.CreateMeetingService()
        self._setting_service = zoom.CreateSettingService()
        self._auth_service = zoom.CreateAuthService()
        logger.info("SDK services created")

        # Set meeting event callback
        self._meeting_event = zoom.MeetingServiceEventCallbacks(
            onMeetingStatusChangedCallback=self._on_meeting_status_changed,
        )
        self._meeting_service.SetEvent(self._meeting_event)

        # Authenticate
        self._auth_event = zoom.AuthServiceEventCallbacks(
            onAuthenticationReturnCallback=self._on_auth_return,
        )
        self._auth_service.SetEvent(self._auth_event)

        auth_context = zoom.AuthContext()
        auth_context.jwt_token = generate_sdk_jwt(
            creds["client_id"], creds["client_secret"]
        )
        logger.info("Calling SDKAuth with JWT (client_id=%s...)...", creds["client_id"][:8])
        auth_result = self._auth_service.SDKAuth(auth_context)
        if auth_result != zoom.SDKERR_SUCCESS:
            raise RuntimeError(f"SDKAuth failed: {auth_result}")
        logger.info("SDKAuth call returned success, waiting for auth callback...")

    def _on_auth_return(self, result) -> None:
        """Called when SDK authentication completes."""
        import zoom_meeting_sdk as zoom
        if result == zoom.AUTHRET_SUCCESS:
            logger.info("SDK auth succeeded, joining meeting %d", self.meeting_number)
            self._join_meeting()
        else:
            logger.error("SDK auth failed: %s", result)
            self._request_shutdown()

    def _join_meeting(self) -> None:
        """Join the Zoom meeting by number + passcode with ZAK token auth."""
        import zoom_meeting_sdk as zoom

        logger.info("Preparing to join meeting %d as '%s' (ZAK length=%d)",
                     self.meeting_number, self.display_name, len(self._zak_token or ""))

        join_param = zoom.JoinParam()
        join_param.userType = zoom.SDKUserType.SDK_UT_WITHOUT_LOGIN

        param = join_param.param
        param.meetingNumber = self.meeting_number
        param.userName = self.display_name
        param.psw = self.passcode
        param.userZAK = self._zak_token
        param.isVideoOff = True
        param.isAudioOff = True
        param.isAudioRawDataStereo = False
        param.isMyVoiceInMix = False
        param.eAudioRawdataSamplingRate = zoom.AudioRawdataSamplingRate.AudioRawdataSamplingRate_32K

        join_result = self._meeting_service.Join(join_param)
        logger.info("Join() returned: %s", join_result)

        # Auto-join audio
        audio_settings = self._setting_service.GetAudioSettings()
        audio_settings.EnableAutoJoinAudio(True)
        logger.info("Auto-join audio enabled")

    def _on_meeting_status_changed(self, status, iResult) -> None:
        """Called when meeting status changes."""
        import zoom_meeting_sdk as zoom
        logger.info("Meeting status changed: %s (iResult=%s)", status, iResult)

        if status == zoom.MEETING_STATUS_INMEETING:
            self._on_joined()
        elif status == zoom.MEETING_STATUS_ENDED:
            logger.info("Meeting ended")
            self._meeting_ended = True
            self._request_shutdown()
        elif status == zoom.MEETING_STATUS_FAILED:
            logger.error("Meeting join failed: %s", iResult)
            self._request_shutdown()

    def _on_joined(self) -> None:
        """Called when we've successfully joined the meeting."""
        import zoom_meeting_sdk as zoom
        from gi.repository import GLib

        logger.info("In meeting %d — setting up audio recording", self.meeting_number)

        # Accept any recording consent reminders automatically
        self._reminder_event = zoom.MeetingReminderEventCallbacks(
            onReminderNotifyCallback=self._on_reminder,
        )
        reminder_ctrl = self._meeting_service.GetMeetingReminderController()
        reminder_ctrl.SetEvent(self._reminder_event)

        # Set up recording privilege callback
        self._recording_ctrl = self._meeting_service.GetMeetingRecordingController()
        self._recording_event = zoom.MeetingRecordingCtrlEventCallbacks(
            onRecordPrivilegeChangedCallback=self._on_record_privilege_changed,
        )
        self._recording_ctrl.SetEvent(self._recording_event)

        # Get participant info
        self._participants_ctrl = self._meeting_service.GetMeetingParticipantsController()
        self._my_participant_id = self._participants_ctrl.GetMySelfUser().GetUserID()

        # Join VoIP (required for raw audio after SDK 6.3.5)
        audio_ctrl = self._meeting_service.GetMeetingAudioController()
        audio_ctrl.JoinVoip()

        # Try to start raw recording after a short delay
        GLib.timeout_add_seconds(1, self._start_raw_recording)

    def _on_reminder(self, content, handler) -> None:
        """Auto-accept meeting reminders (recording consent, etc.)."""
        if handler:
            handler.Accept()

    def _on_record_privilege_changed(self, can_rec) -> None:
        """Called when recording privilege changes."""
        from gi.repository import GLib
        logger.info("Recording privilege changed: %s", can_rec)
        if can_rec:
            GLib.timeout_add_seconds(1, self._start_raw_recording)

    def _start_raw_recording(self) -> bool:
        """Start raw audio recording. Returns False to cancel GLib timeout."""
        import zoom_meeting_sdk as zoom

        if self._is_recording:
            return False

        can_start = self._recording_ctrl.CanStartRawRecording()
        if can_start != zoom.SDKERR_SUCCESS:
            self._recording_ctrl.RequestLocalRecordingPrivilege()
            logger.info("Requested recording privilege, waiting...")
            return False

        start_result = self._recording_ctrl.StartRawRecording()
        if start_result != zoom.SDKERR_SUCCESS:
            logger.error("StartRawRecording failed: %s", start_result)
            return False

        # Subscribe to raw audio
        self._audio_helper = zoom.GetAudioRawdataHelper()
        if not self._audio_helper:
            logger.error("GetAudioRawdataHelper returned None")
            return False

        self._audio_source = zoom.ZoomSDKAudioRawDataDelegateCallbacks(
            onOneWayAudioRawDataReceivedCallback=self._on_audio_data,
            collectPerformanceData=False,
        )
        subscribe_result = self._audio_helper.subscribe(self._audio_source, False)
        logger.info("Audio subscribe result: %s", subscribe_result)

        self._is_recording = True
        logger.info("Raw audio recording started")
        return False

    def _on_audio_data(self, data, node_id) -> None:
        """Called for each chunk of raw PCM audio from a participant."""
        # Skip our own audio
        if node_id == self._my_participant_id:
            return
        pcm_bytes = data.GetBuffer()
        if pcm_bytes:
            self._pcm_chunks.append(pcm_bytes)

    def _on_signal(self, signum, frame) -> None:
        """Handle SIGINT/SIGTERM."""
        logger.info("Received signal %d", signum)
        self._request_shutdown()

    def _request_shutdown(self) -> None:
        """Request clean shutdown via GLib main loop."""
        self._shutdown_requested = True

    def _check_shutdown(self) -> bool:
        """GLib timeout callback — returns False to stop when shutdown requested."""
        if self._shutdown_requested:
            if self._main_loop:
                self._main_loop.quit()
            return False
        return True

    def _finalize(self) -> None:
        """Clean up SDK, upload audio, enqueue transcription."""
        import zoom_meeting_sdk as zoom

        logger.info("Finalizing — meeting_ended=%s, chunks=%d",
                     self._meeting_ended, len(self._pcm_chunks))

        # Stop recording
        if self._is_recording and self._recording_ctrl:
            try:
                self._recording_ctrl.StopRawRecording()
            except Exception as e:
                logger.warning("StopRawRecording error: %s", e)

        # Unsubscribe audio
        if self._audio_helper:
            try:
                self._audio_helper.unSubscribe()
            except Exception:
                pass

        # Leave meeting
        if self._meeting_service:
            try:
                status = self._meeting_service.GetMeetingStatus()
                if status != zoom.MEETING_STATUS_IDLE:
                    self._meeting_service.Leave(zoom.LEAVE_MEETING)
                    time.sleep(1)
            except Exception:
                pass

        # Destroy services
        for svc, destroy_fn in [
            (self._meeting_service, zoom.DestroyMeetingService),
            (self._setting_service, zoom.DestroySettingService),
            (self._auth_service, zoom.DestroyAuthService),
        ]:
            if svc:
                try:
                    destroy_fn(svc)
                except Exception:
                    pass

        try:
            zoom.CleanUPSDK()
        except Exception:
            pass

        # Upload audio if we captured anything
        if self._pcm_chunks:
            pcm_data = b"".join(self._pcm_chunks)
            logger.info("Captured %d bytes of PCM audio", len(pcm_data))
            wav_data = pcm_to_wav(pcm_data)
            gcs_uri = upload_wav_to_gcs(wav_data, self.meeting_id, self.owning_user)
            enqueue_transcription(self.meeting_id, gcs_uri, self.owning_user)
        else:
            logger.warning("No audio captured")

        logger.info("Done")
