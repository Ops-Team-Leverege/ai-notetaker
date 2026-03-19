"""
Zoom Meeting Bot — joins meetings via the Zoom Meeting SDK and captures raw audio.

Uses zoom-meeting-sdk Python bindings (https://pypi.org/project/zoom-meeting-sdk/).
Runs inside Docker with PulseAudio virtual sink for headless audio.
"""

import os
import io
import sys
import wave
import hashlib
import json
import logging
import signal
import time
import traceback
from datetime import datetime, timedelta
from typing import Optional

import jwt
import requests

from src.log import log

logger = logging.getLogger("zoom-bot")

SDK_SAMPLE_RATE = 32000
SDK_SAMPLE_WIDTH = 2
SDK_CHANNELS = 1

PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "ai-meeting-notetaker-490206")
REGION = os.environ.get("GCP_REGION", "us-central1")
AUDIO_BUCKET = os.environ.get("AUDIO_BUCKET", "leverege-notetaker-audio")
QUEUE_NAME = os.environ.get("TRANSCRIPTION_QUEUE", "transcription-queue")
WORKER_URL = os.environ.get("TRANSCRIPTION_WORKER_URL", "")


def generate_sdk_jwt(client_id: str, client_secret: str) -> str:
    import time as _time
    iat = int(_time.time()) - 30  # 30s in the past for clock skew
    exp = iat + 60 * 60 * 2       # 2 hours (Zoom recommended)
    payload = {
        "appKey": client_id,
        "sdkKey": client_id,
        "iat": iat,
        "exp": exp,
        "tokenExp": exp,
    }
    return jwt.encode(payload, client_secret, algorithm="HS256")


def hash_user_email(email: str) -> str:
    return hashlib.sha256(email.encode()).hexdigest()


def pcm_to_wav(pcm_data: bytes, sample_rate: int = SDK_SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(SDK_CHANNELS)
        wf.setsampwidth(SDK_SAMPLE_WIDTH)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


def fetch_sdk_credentials() -> dict:
    from google.cloud import secretmanager
    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{PROJECT_ID}/secrets/zoom-sdk-credentials/versions/latest"
    response = client.access_secret_version(request={"name": name})
    return json.loads(response.payload.data.decode("utf-8"))


def fetch_s2s_credentials() -> dict:
    from google.cloud import secretmanager
    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{PROJECT_ID}/secrets/zoom-account-credentials/versions/latest"
    response = client.access_secret_version(request={"name": name})
    return json.loads(response.payload.data.decode("utf-8"))


def get_s2s_access_token(creds: dict) -> str:
    basic_auth = (creds["client_id"], creds["client_secret"])
    # Try account_credentials first (S2S OAuth app), fall back to client_credentials (General App)
    account_id = creds.get("account_id")
    if account_id:
        data = {
            "grant_type": "account_credentials",
            "account_id": account_id,
        }
    else:
        data = {
            "grant_type": "client_credentials",
        }
    log(f"Requesting access token with grant_type={data['grant_type']}")
    resp = requests.post(
        "https://zoom.us/oauth/token",
        auth=basic_auth,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    # If account_credentials fails, retry with client_credentials
    if resp.status_code == 400 and account_id:
        log("account_credentials grant failed (400), retrying with client_credentials...")
        resp = requests.post(
            "https://zoom.us/oauth/token",
            auth=basic_auth,
            data={"grant_type": "client_credentials"},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
        )
    resp.raise_for_status()
    return resp.json()["access_token"]


def fetch_zak_token(access_token: str, bot_user_id: str = "me") -> str:
    url = f"https://api.zoom.us/v2/users/{bot_user_id}/token"
    log(f"Fetching ZAK from {url}")
    resp = requests.get(
        url,
        params={"type": "zak"},
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    if resp.status_code != 200:
        log(f"ZAK fetch failed: status={resp.status_code} body={resp.text[:500]}")
    resp.raise_for_status()
    return resp.json()["token"]


def upload_wav_to_gcs(wav_data: bytes, meeting_id: str, owning_user: str) -> str:
    from google.cloud import storage
    user_hash = hash_user_email(owning_user)
    gcs_path = f"{user_hash}/{meeting_id}/audio.wav"
    client = storage.Client()
    bucket = client.bucket(AUDIO_BUCKET)
    blob = bucket.blob(gcs_path)
    blob.upload_from_string(wav_data, content_type="audio/wav")
    uri = f"gs://{AUDIO_BUCKET}/{gcs_path}"
    log(f"Uploaded audio to {uri}")
    return uri


def enqueue_transcription(meeting_id: str, audio_gcs_path: str, owning_user: str) -> None:
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
    log(f"Enqueued transcription task for meeting {meeting_id}")


class ZoomMeetingBot:
    def __init__(self, meeting_id: str, meeting_number: int, passcode: str,
                 owning_user: str, display_name: str = "Leverege Notetaker"):
        self.meeting_id = meeting_id
        self.meeting_number = meeting_number
        self.passcode = passcode
        self.owning_user = owning_user
        self.display_name = display_name

        self._meeting_service = None
        self._auth_service = None
        self._setting_service = None
        self._recording_ctrl = None
        self._audio_helper = None
        self._audio_source = None
        self._participants_ctrl = None
        self._my_participant_id = None

        self._pcm_chunks: list[bytes] = []
        self._is_recording = False
        self._meeting_ended = False
        self._zak_token: Optional[str] = None

        self._main_loop = None
        self._shutdown_requested = False
        self._auth_received = False
        self._joined_meeting = False

    def run(self) -> None:
        """Main entry point — blocks until meeting ends."""
        import gi
        gi.require_version("GLib", "2.0")
        from gi.repository import GLib

        log(f"Bot.run() starting for meeting {self.meeting_number} user={self.owning_user}")

        # --- Fetch credentials ---
        log("Fetching SDK credentials from Secret Manager...")
        sdk_creds = fetch_sdk_credentials()
        log(f"SDK credentials OK (client_id={sdk_creds.get('client_id', '?')[:8]}... secret_len={len(sdk_creds.get('client_secret', ''))})")
        # Validate no whitespace/encoding issues
        cid = sdk_creds.get("client_id", "")
        csec = sdk_creds.get("client_secret", "")
        if cid != cid.strip() or csec != csec.strip():
            log("WARNING: SDK credentials have leading/trailing whitespace — stripping")
            sdk_creds["client_id"] = cid.strip()
            sdk_creds["client_secret"] = csec.strip()

        log("Fetching S2S OAuth credentials from Secret Manager...")
        s2s_creds = fetch_s2s_credentials()
        log(f"S2S credentials OK (client_id={s2s_creds.get('client_id', '?')[:8]}...)")

        log("Getting access token from Zoom...")
        access_token = get_s2s_access_token(s2s_creds)
        log(f"S2S access token OK (length={len(access_token)})")

        # Use bot_user_id from credentials if available, otherwise "me"
        bot_user_id = s2s_creds.get("bot_user_id", "me")
        log(f"Fetching ZAK token from Zoom API (user={bot_user_id})...")
        self._zak_token = fetch_zak_token(access_token, bot_user_id)
        log(f"ZAK token OK (length={len(self._zak_token)}, first10={self._zak_token[:10]}...)")

        # --- Verify container environment ---
        self._check_environment()

        # --- Initialize SDK ---
        log("Initializing Zoom Meeting SDK...")
        self._init_sdk(sdk_creds)
        log("SDK initialized, auth requested — waiting for callbacks via GLib main loop")

        # Set up signal handlers
        signal.signal(signal.SIGINT, self._on_signal)
        signal.signal(signal.SIGTERM, self._on_signal)

        # Run GLib main loop — this BLOCKS until meeting ends or shutdown requested
        self._main_loop = GLib.MainLoop()
        GLib.timeout_add(100, self._check_shutdown)

        # Auth timeout — if callback doesn't fire within 30s, something is wrong
        def _auth_timeout():
            if not self._auth_received:
                log("TIMEOUT: Auth callback never fired after 30 seconds")
                log("This usually means the SDK credentials are wrong (OAuth creds vs SDK creds) or the environment is missing dbus/PulseAudio")
                self._request_shutdown()
            return False  # don't repeat
        GLib.timeout_add_seconds(30, _auth_timeout)

        # Meeting join timeout — if not in meeting within 60s of auth, exit
        def _join_timeout():
            if self._auth_received and not self._joined_meeting:
                log("TIMEOUT: Meeting join never completed after 60 seconds")
                log("Auth succeeded but meeting join callback never fired — check meeting number/passcode/ZAK token")
                self._request_shutdown()
            return False
        GLib.timeout_add_seconds(90, _join_timeout)  # 90s total = ~30s auth + 60s join

        log(">>> GLib.MainLoop().run() — BLOCKING until meeting ends <<<")
        try:
            self._main_loop.run()
        except Exception as e:
            log(f"GLib main loop error: {e}")
            log(traceback.format_exc())
        finally:
            log("GLib main loop exited, finalizing...")
            self._finalize()

    def _check_environment(self) -> None:
        """Check that dbus and PulseAudio are running inside the container."""
        import subprocess

        log("Checking container environment...")

        # Check dbus
        try:
            result = subprocess.run(["pgrep", "dbus-daemon"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                log(f"dbus-daemon is running (PID: {result.stdout.strip()})")
            else:
                log("WARNING: dbus-daemon is NOT running — SDK auth callback may not fire")
        except Exception as e:
            log(f"WARNING: Could not check dbus-daemon: {e}")

        # Check PulseAudio
        try:
            result = subprocess.run(["pactl", "info"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                for line in result.stdout.splitlines()[:5]:
                    log(f"  PulseAudio: {line.strip()}")
            else:
                log(f"WARNING: pactl info failed (rc={result.returncode}): {result.stderr.strip()}")
        except Exception as e:
            log(f"WARNING: Could not check PulseAudio: {e}")

        # Check zoomus.conf
        try:
            with open("/root/.config/zoomus.conf", "r") as f:
                content = f.read().strip()
                log(f"zoomus.conf: {content}")
        except Exception as e:
            log(f"WARNING: Could not read zoomus.conf: {e}")

        log("Environment check complete")

    def _init_sdk(self, creds: dict) -> None:
        """Initialize the Zoom Meeting SDK, authenticate, and join."""
        import zoom_meeting_sdk as zoom

        log("_init_sdk: creating InitParam...")
        init_param = zoom.InitParam()
        init_param.strWebDomain = "https://zoom.us"
        init_param.strSupportUrl = "https://zoom.us"
        init_param.enableGenerateDump = True
        init_param.emLanguageID = zoom.SDK_LANGUAGE_ID.LANGUAGE_English
        init_param.enableLogByDefault = True

        log("_init_sdk: calling InitSDK()...")
        result = zoom.InitSDK(init_param)
        log(f"_init_sdk: InitSDK returned {result} (SUCCESS={zoom.SDKERR_SUCCESS})")
        if result != zoom.SDKERR_SUCCESS:
            raise RuntimeError(f"InitSDK failed: {result}")

        log("_init_sdk: creating SDK services...")
        self._meeting_service = zoom.CreateMeetingService()
        self._setting_service = zoom.CreateSettingService()
        self._auth_service = zoom.CreateAuthService()
        log("_init_sdk: SDK services created OK")

        # Meeting status callback
        self._meeting_event = zoom.MeetingServiceEventCallbacks(
            onMeetingStatusChangedCallback=self._on_meeting_status_changed,
        )
        self._meeting_service.SetEvent(self._meeting_event)
        log("_init_sdk: meeting event callback registered")

        # Auth callback
        self._auth_event = zoom.AuthServiceEventCallbacks(
            onAuthenticationReturnCallback=self._on_auth_return,
        )
        self._auth_service.SetEvent(self._auth_event)
        log("_init_sdk: auth event callback registered")

        # Generate JWT and authenticate
        jwt_token = generate_sdk_jwt(creds["client_id"], creds["client_secret"])
        log(f"_init_sdk: JWT generated (length={len(jwt_token)})")
        log(f"_init_sdk: JWT first 50 chars: {jwt_token[:50]}...")

        # Decode and log JWT payload for debugging (without verifying signature)
        try:
            decoded = jwt.decode(jwt_token, creds["client_secret"], algorithms=["HS256"])
            log(f"_init_sdk: JWT payload appKey={decoded.get('appKey', '?')[:8]}... sdkKey={decoded.get('sdkKey', 'MISSING')[:8]}... iat={decoded.get('iat')} exp={decoded.get('exp')} tokenExp={decoded.get('tokenExp')}")
        except Exception as e:
            log(f"_init_sdk: JWT decode for debug failed: {e}")

        # Log credential lengths for sanity check
        log(f"_init_sdk: client_id length={len(creds['client_id'])} client_secret length={len(creds['client_secret'])}")

        auth_context = zoom.AuthContext()
        auth_context.jwt_token = jwt_token

        log(f"_init_sdk: calling SDKAuth (client_id={creds['client_id'][:8]}...)...")
        auth_result = self._auth_service.SDKAuth(auth_context)
        log(f"_init_sdk: SDKAuth returned {auth_result} (SUCCESS={zoom.SDKERR_SUCCESS})")
        if auth_result != zoom.SDKERR_SUCCESS:
            raise RuntimeError(f"SDKAuth failed: {auth_result}")
        log("_init_sdk: SDKAuth dispatched, waiting for async auth callback...")


    def _on_auth_return(self, result) -> None:
        """Called when SDK authentication completes (async callback)."""
        import zoom_meeting_sdk as zoom
        self._auth_received = True
        log(f"AUTH CALLBACK: result={result} (SUCCESS={zoom.AUTHRET_SUCCESS})")

        # Log known auth result codes for debugging
        auth_codes = {
            getattr(zoom, 'AUTHRET_SUCCESS', None): 'SUCCESS',
            getattr(zoom, 'AUTHRET_JWTTOKENWRONG', None): 'JWT_TOKEN_WRONG',
            getattr(zoom, 'AUTHRET_UNKNOWN', None): 'UNKNOWN',
        }
        code_name = auth_codes.get(result, f'UNRECOGNIZED({result})')
        log(f"AUTH CALLBACK: {code_name}")

        if result == zoom.AUTHRET_SUCCESS:
            log("Auth succeeded, calling _join_meeting()...")
            self._join_meeting()
        else:
            log(f"AUTH FAILED: {code_name} (code={result})")
            log("If AUTHRET_JWTTOKENWRONG: check that zoom-sdk-credentials contains the General App's Client ID + Client Secret, NOT the S2S OAuth creds")
            log("If AUTHRET_UNKNOWN: check dbus, PulseAudio, and zoomus.conf are set up correctly in the container")
            self._request_shutdown()

    def _join_meeting(self) -> None:
        """Join the Zoom meeting by number + passcode with ZAK token auth."""
        import zoom_meeting_sdk as zoom

        log(f"Joining meeting {self.meeting_number} as '{self.display_name}' (ZAK length={len(self._zak_token or '')})")

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

        log(f"Calling meeting_service.Join() with number={self.meeting_number}...")
        join_result = self._meeting_service.Join(join_param)
        log(f"Join() returned: {join_result} (SUCCESS={zoom.SDKERR_SUCCESS})")

        # Auto-join audio
        audio_settings = self._setting_service.GetAudioSettings()
        audio_settings.EnableAutoJoinAudio(True)
        log("Auto-join audio enabled")

    def _on_meeting_status_changed(self, status, iResult) -> None:
        """Called when meeting status changes (async callback)."""
        import zoom_meeting_sdk as zoom
        log(f"MEETING STATUS CHANGED: status={status} iResult={iResult}")
        log(f"  INMEETING={zoom.MEETING_STATUS_INMEETING} ENDED={zoom.MEETING_STATUS_ENDED} FAILED={zoom.MEETING_STATUS_FAILED}")

        if status == zoom.MEETING_STATUS_INMEETING:
            log("STATUS: IN MEETING — setting up audio recording")
            self._joined_meeting = True
            self._on_joined()
        elif status == zoom.MEETING_STATUS_ENDED:
            log("STATUS: MEETING ENDED")
            self._meeting_ended = True
            self._request_shutdown()
        elif status == zoom.MEETING_STATUS_FAILED:
            log(f"STATUS: MEETING JOIN FAILED (iResult={iResult})")
            self._request_shutdown()
        else:
            log(f"STATUS: other ({status})")

    def _on_joined(self) -> None:
        """Called when we've successfully joined the meeting."""
        import zoom_meeting_sdk as zoom
        from gi.repository import GLib

        log(f"In meeting {self.meeting_number} — setting up audio recording")

        self._reminder_event = zoom.MeetingReminderEventCallbacks(
            onReminderNotifyCallback=self._on_reminder,
        )
        reminder_ctrl = self._meeting_service.GetMeetingReminderController()
        reminder_ctrl.SetEvent(self._reminder_event)

        self._recording_ctrl = self._meeting_service.GetMeetingRecordingController()
        self._recording_event = zoom.MeetingRecordingCtrlEventCallbacks(
            onRecordPrivilegeChangedCallback=self._on_record_privilege_changed,
        )
        self._recording_ctrl.SetEvent(self._recording_event)

        self._participants_ctrl = self._meeting_service.GetMeetingParticipantsController()
        self._my_participant_id = self._participants_ctrl.GetMySelfUser().GetUserID()
        log(f"My participant ID: {self._my_participant_id}")

        audio_ctrl = self._meeting_service.GetMeetingAudioController()
        audio_ctrl.JoinVoip()
        log("JoinVoip() called")

        GLib.timeout_add_seconds(1, self._start_raw_recording)
        log("Scheduled raw recording start in 1 second")

    def _on_reminder(self, content, handler) -> None:
        log("Reminder received, auto-accepting")
        if handler:
            handler.Accept()

    def _on_record_privilege_changed(self, can_rec) -> None:
        from gi.repository import GLib
        log(f"Recording privilege changed: {can_rec}")
        if can_rec:
            GLib.timeout_add_seconds(1, self._start_raw_recording)

    def _start_raw_recording(self) -> bool:
        import zoom_meeting_sdk as zoom

        if self._is_recording:
            return False

        can_start = self._recording_ctrl.CanStartRawRecording()
        log(f"CanStartRawRecording: {can_start} (SUCCESS={zoom.SDKERR_SUCCESS})")
        if can_start != zoom.SDKERR_SUCCESS:
            self._recording_ctrl.RequestLocalRecordingPrivilege()
            log("Requested recording privilege, waiting...")
            return False

        start_result = self._recording_ctrl.StartRawRecording()
        log(f"StartRawRecording: {start_result}")
        if start_result != zoom.SDKERR_SUCCESS:
            log(f"StartRawRecording FAILED: {start_result}")
            return False

        self._audio_helper = zoom.GetAudioRawdataHelper()
        if not self._audio_helper:
            log("GetAudioRawdataHelper returned None")
            return False

        self._audio_source = zoom.ZoomSDKAudioRawDataDelegateCallbacks(
            onOneWayAudioRawDataReceivedCallback=self._on_audio_data,
            collectPerformanceData=False,
        )
        subscribe_result = self._audio_helper.subscribe(self._audio_source, False)
        log(f"Audio subscribe result: {subscribe_result}")

        self._is_recording = True
        log("Raw audio recording STARTED")
        return False

    def _on_audio_data(self, data, node_id) -> None:
        if node_id == self._my_participant_id:
            return
        pcm_bytes = data.GetBuffer()
        if pcm_bytes:
            self._pcm_chunks.append(pcm_bytes)

    def _on_signal(self, signum, frame) -> None:
        log(f"Received signal {signum}")
        self._request_shutdown()

    def _request_shutdown(self) -> None:
        log("Shutdown requested")
        self._shutdown_requested = True

    def _check_shutdown(self) -> bool:
        if self._shutdown_requested:
            log("_check_shutdown: quitting GLib main loop")
            if self._main_loop:
                self._main_loop.quit()
            return False
        return True

    def _finalize(self) -> None:
        """Clean up SDK resources and upload captured audio."""
        import traceback

        log("_finalize: starting cleanup...")

        # Stop raw recording
        if self._is_recording and self._recording_ctrl:
            try:
                import zoom_meeting_sdk as zoom
                self._recording_ctrl.StopRawRecording()
                log("_finalize: raw recording stopped")
            except Exception as e:
                log(f"_finalize: StopRawRecording error: {e}")

        # Unsubscribe audio
        if self._audio_helper and self._audio_source:
            try:
                self._audio_helper.unSubscribe()
                log("_finalize: audio unsubscribed")
            except Exception as e:
                log(f"_finalize: audio unsubscribe error: {e}")

        # Leave meeting
        if self._meeting_service:
            try:
                import zoom_meeting_sdk as zoom
                self._meeting_service.Leave(zoom.LEAVE_MEETING)
                log("_finalize: left meeting")
            except Exception as e:
                log(f"_finalize: Leave error: {e}")

        # Destroy SDK services
        try:
            import zoom_meeting_sdk as zoom
            if self._meeting_service:
                zoom.DestroyMeetingService(self._meeting_service)
                log("_finalize: meeting service destroyed")
            if self._auth_service:
                zoom.DestroyAuthService(self._auth_service)
                log("_finalize: auth service destroyed")
            if self._setting_service:
                zoom.DestroySettingService(self._setting_service)
                log("_finalize: setting service destroyed")
            zoom.CleanUPSDK()
            log("_finalize: SDK cleaned up")
        except Exception as e:
            log(f"_finalize: SDK cleanup error: {e}")

        # Upload audio if we captured anything
        total_bytes = sum(len(c) for c in self._pcm_chunks)
        log(f"_finalize: captured {total_bytes} bytes of PCM audio ({len(self._pcm_chunks)} chunks)")

        if total_bytes > 0:
            try:
                wav_data = pcm_to_wav(b"".join(self._pcm_chunks))
                log(f"_finalize: WAV encoded ({len(wav_data)} bytes)")

                gcs_uri = upload_wav_to_gcs(wav_data, self.meeting_id, self.owning_user)
                log(f"_finalize: audio uploaded to {gcs_uri}")

                enqueue_transcription(self.meeting_id, gcs_uri, self.owning_user)
                log("_finalize: transcription task enqueued")
            except Exception as e:
                log(f"_finalize: upload/enqueue FAILED: {e}")
                log(traceback.format_exc())
        else:
            log("_finalize: no audio captured, skipping upload")

        log("_finalize: done")
