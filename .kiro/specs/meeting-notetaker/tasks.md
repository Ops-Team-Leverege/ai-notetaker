# Implementation Plan: Leverege Meeting Notetaker

## Overview

Phased implementation following the build phases defined in requirements: Phase 1 (internal Google Meet via Workspace Events API + transcription pipeline + basic UI), Phase 2 (Zoom bot), Phase 3 (Teams bot), Phase 4 (calendar integration). TypeScript/Node.js for backend API, bot orchestrator, and React UI. Python for transcription worker and GPU pipeline. Property-based tests use fast-check (TS) and Hypothesis (Python).

## Tasks

- [x] 0. GCP Infrastructure Setup
  - [x] 0.1 Create Cloud Storage buckets (`leverege-notetaker-audio`, `leverege-notetaker-transcripts`) with Google-managed encryption and per-user path IAM policies
  - [x] 0.2 Create Cloud SQL instance (db-f1-micro to start), run migrations for meetings, speaker_labels, and sessions tables
  - [x] 0.3 Create Secret Manager secrets with placeholder values for: Google OAuth credentials, Zoom account credentials, Microsoft account credentials, Cloud SQL connection string
  - [x] 0.4 Configure Eventarc trigger on `leverege-notetaker-audio` bucket for object-finalized events → `POST /internal/trigger-transcription`
  - [x] 0.5 Create Cloud Tasks queue with `maxConcurrentDispatches: 5` and exponential backoff retry policy
  - [x] 0.6 Create Cloud Scheduler job for nightly session cleanup (`DELETE FROM sessions WHERE expires_at < NOW()`)
  - [x] 0.7 Create service accounts with minimum required IAM roles:
    - `notetaker-bot@` (Storage Writer, Cloud SQL Client)
    - `transcription-worker@` (Compute Admin, Storage Admin, Cloud SQL Client)
    - `pipeline@` (Storage Admin, Cloud SQL Client)
  - [x] 0.8 Register Workspace Events API subscription — call Workspace Events API to deliver push notifications to `POST /api/workspace/events` when a Meet session ends

- [x] 1. Project scaffolding, data models, and database schema
  - [x] 1.1 Create monorepo directory structure and initialize packages
    - Create top-level directories: `api/` (Node.js/TS), `transcription-worker/` (Python), `pipeline/` (Python), `web-ui/` (React/TS), `bot/` (Node.js/TS)
    - Initialize `package.json` for TS packages, `pyproject.toml` / `requirements.txt` for Python packages
    - Set up TypeScript config, ESLint, Prettier for TS packages
    - Set up pytest, Hypothesis for Python packages
    - Set up fast-check and vitest for TS packages
    - Create shared `tests/` directory structure matching design test organization
    - _Requirements: all (foundational)_

  - [x] 1.2 Define core TypeScript interfaces and types
    - Create `TranscriptEntry`, `MeetingMetadata`, `TranscriptionTask`, `BotSession`, `BotStatus`, `PlatformCredentials`, `AudioBuffer`, `Session`, `User` interfaces per design
    - Create platform enum type: `'google_meet' | 'zoom' | 'teams'`
    - Create transcription status enum: `'pending' | 'transcription_pending' | 'processing' | 'completed' | 'transcription_failed'`
    - _Requirements: 8.1, 9.1, 1.2_

  - [x] 1.3 Create Cloud SQL migration scripts
    - Write migration for `meetings` table with all columns, CHECK constraints, and indexes per design schema
    - Write migration for `speaker_labels` table with foreign key, UNIQUE constraint per design schema
    - Write migration for `sessions` table with expiry index per design schema
    - _Requirements: 9.1, 12.4, 13.3_

  - [ ]* 1.4 Write property test for meeting metadata record completeness
    - **Property 11: Meeting metadata record completeness**
    - **Validates: Requirements 9.1, 9.2**

- [x] 2. Authentication service and session management
  - [x] 2.1 Implement Auth Service with Google SSO
    - Implement `initiateLogin()` — build Google OAuth 2.0 authorization URL with OpenID Connect scopes
    - Implement `handleCallback()` — exchange authorization code for tokens, extract user info, create session in Cloud SQL
    - Implement `validateSession()` — look up session token in Cloud SQL, check expiry, return `User | null`
    - Implement `logout()` — delete session row from Cloud SQL
    - Store OAuth client credentials in Secret Manager, fetch at startup
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x] 2.2 Implement auth and ownership middleware
    - `authMiddleware` — extract session token from cookie/header, call `validateSession()`, attach user to request context; return 401 if invalid/expired
    - `ownershipMiddleware` — query meeting by ID, verify `owning_user` matches authenticated user; return 403 if mismatch
    - `rateLimitMiddleware` — rate limit on `POST /api/meetings` per user
    - _Requirements: 13.2, 13.5, 14.2, 14.3_

  - [x] 2.3 Implement auth API routes
    - `POST /api/auth/callback` — Google SSO OAuth callback (public)
    - `POST /api/auth/logout` — invalidate session (requires auth)
    - `GET /api/auth/me` — return current user info (requires auth)
    - _Requirements: 13.1, 13.3, 13.4_

  - [x] 2.4 Implement session cleanup Cloud Scheduler job
    - Create endpoint or script that runs `DELETE FROM sessions WHERE expires_at < NOW()`
    - Configure Cloud Scheduler for nightly execution
    - _Requirements: 13.5 (session hygiene)_

  - [ ]* 2.5 Write property test for unauthenticated request redirect
    - **Property 16: Unauthenticated request redirect**
    - **Validates: Requirements 13.2, 13.5**

  - [ ]* 2.6 Write property test for logout invalidates session
    - **Property 17: Logout invalidates session**
    - **Validates: Requirement 13.4**

  - [ ]* 2.7 Write property test for unauthorized access denied
    - **Property 18: Unauthorized access denied**
    - **Validates: Requirement 14.3**

  - [ ]* 2.8 Write unit tests for auth service
    - Test OAuth callback with valid/invalid authorization codes
    - Test session expiry handling
    - Test SSE connection closed on session expiry
    - _Requirements: 13.1–13.5_

- [x] 3. Checkpoint — Auth and data layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Backend API — meetings CRUD and data scoping (Phase 1)
  - [x] 4.1 Implement meeting submission endpoint
    - `POST /api/meetings` — accept meeting link, validate URL, detect platform, create meeting record in Cloud SQL with status `pending`, dispatch bot (Phase 2+) or handle via Workspace Events (Phase 1)
    - Implement platform detection function: classify URL as `google_meet`, `zoom`, or `teams` based on domain/path; reject unsupported URLs
    - _Requirements: 10.1, 10.2, 1.2_

  - [ ]* 4.2 Write property test for platform detection
    - **Property 1: Platform detection from meeting URL**
    - **Validates: Requirement 1.2**

  - [x] 4.3 Implement meeting list and detail endpoints
    - `GET /api/meetings` — list meetings filtered by `owning_user = authenticated user`
    - `GET /api/meetings/:id` — get single meeting metadata, ownership-checked
    - _Requirements: 11.1, 11.2, 11.3, 14.1, 14.2_

  - [ ]* 4.4 Write property test for per-user data scoping
    - **Property 12: Per-user data scoping**
    - **Validates: Requirements 11.1, 11.3, 14.1, 14.2**

  - [x] 4.5 Implement transcript retrieval with speaker label merge
    - `GET /api/meetings/:id/transcript` — fetch Transcript_JSON from Cloud Storage, fetch `speaker_labels` from Cloud SQL, merge custom labels into transcript entries, return merged result
    - Raw Transcript_JSON in Cloud Storage is never modified
    - _Requirements: 12.1, 12.3, 12.4_

  - [ ]* 4.6 Write property test for transcript merge correctness
    - **Property 19: Transcript merge correctness**
    - **Validates: Requirement 12.4, transcript merge behavior**

  - [x] 4.7 Implement speaker label rename endpoint
    - `PATCH /api/meetings/:id/speakers` — upsert `speaker_labels` row (meeting_id, original_label, custom_label)
    - Ownership-checked
    - _Requirements: 12.4_

  - [ ]* 4.8 Write property test for speaker label rename persistence
    - **Property 15: Speaker label rename persistence**
    - **Validates: Requirement 12.4**

  - [ ]* 4.9 Write unit tests for API layer
    - Test Cloud Tasks creation retry — 3 retries then `transcription_pending` (Req 4.3, 4.4)
    - Test transcript not yet available — returns current status (Req 12.5)
    - Test transcript merge — custom labels applied, raw file unchanged
    - _Requirements: 4.3, 4.4, 12.4, 12.5_

- [x] 5. Workspace Events API integration (Phase 1)
  - [x] 5.1 Implement workspace event signature verification middleware
    - `workspaceSignatureMiddleware` — verify Google-signed request header on `POST /api/workspace/events`; return 403 on failure
    - _Requirements: Workspace Events webhook security_

  - [ ]* 5.2 Write property test for workspace event signature rejection
    - **Property 20: Workspace event signature rejection**
    - **Validates: Workspace Events webhook security**

  - [x] 5.3 Implement workspace event handler
    - `POST /api/workspace/events` — parse meeting completed event, convert Workspace transcript to Transcript_JSON format, upload to Cloud Storage, create meeting metadata record with status `completed`
    - Implement `convertTranscript()` — map Workspace transcript entries to `TranscriptEntry[]` with `speaker`, `text`, `timestamp` (ISO 8601)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 5.4 Write property test for workspace transcript conversion completeness
    - **Property 3: Workspace transcript conversion completeness**
    - **Validates: Requirement 2.2**

  - [x] 5.5 Implement workspace event error handling
    - Log errors when transcript unavailable or API returns error
    - Notify user via Web_UI on failure
    - _Requirements: 2.5_

  - [ ]* 5.6 Write unit tests for workspace events
    - Test signature verification with valid/invalid signatures
    - Test transcript conversion edge cases
    - _Requirements: 2.1–2.5_

- [x] 6. Checkpoint — Phase 1 backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Transcription Worker (Cloud Run — Python)
  - [x] 7.1 Implement Eventarc trigger endpoint
    - `POST /internal/trigger-transcription` — receive GCS object-finalized event from Eventarc, extract `gcs_path`, `meeting_id`, `owning_user` from event metadata
    - Update meeting status to `transcription_pending` in Cloud SQL
    - Create Cloud Tasks job with `TranscriptionTask` payload (`meetingId`, `audioGcsPath`, `owningUser`, `retryCount: 0`)
    - Retry Cloud Tasks creation up to 3× with exponential backoff; on final failure mark `transcription_pending`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 7.2 Write property test for task payload includes required fields
    - **Property 5: Task payload includes required fields**
    - **Validates: Requirement 4.2**

  - [x] 7.3 Implement Cloud Tasks job handler
    - `POST /tasks/transcribe` — receive `TranscriptionTask` payload from Cloud Tasks
    - Check `retryCount >= 4` → mark `transcription_failed`, return 200 (do not process)
    - Create preemptible n1-standard-4 + T4 GPU Compute Engine instance via API
    - Inject task parameters as instance metadata (startup script reads them)
    - Poll for instance completion, return 200 to Cloud Tasks on success
    - _Requirements: 4.5, 5.2, 5.5, 6.7_

  - [x] 7.4 Configure Cloud Tasks queue
    - Set `maxConcurrentDispatches: 5` to enforce concurrent job limit
    - Configure retry policy with exponential backoff
    - _Requirements: 4.5_

  - [ ]* 7.5 Write property test for concurrent transcription job limit
    - **Property 6: Concurrent transcription job limit**
    - **Validates: Requirement 4.5**

  - [ ]* 7.6 Write unit tests for transcription worker
    - Test `retryCount >= 4` check — verify job rejected, not processed
    - Test Cloud Tasks creation retry — 3 retries then failure
    - Test GPU preemption retry — verify re-enqueue up to 5 times then failure
    - _Requirements: 4.3, 4.4, 5.5, 6.7_

- [x] 8. Transcription Pipeline (T4 GPU Instance — Python)
  - [x] 8.1 Implement pipeline startup script and orchestrator
    - Read job parameters from instance metadata (`audio_gcs_path`, `meeting_id`, `owning_user`)
    - Download audio from Cloud Storage
    - Run Whisper → pyannote → align → upload → update status → delete audio → self-shutdown
    - Implement `TranscriptionPipeline.run()` orchestrating the full pipeline
    - _Requirements: 5.1, 6.1, 6.4, 6.5, 7.1, 7.2_

  - [x] 8.2 Implement Whisper transcription
    - Implement `TranscriptionPipeline.transcribe()` — load self-hosted Whisper model, process audio file entirely on GCP instance
    - No external API calls — audio never leaves GCP
    - Return `WhisperResult` with segments and timestamps
    - _Requirements: 5.1, 5.2_

  - [x] 8.3 Implement pyannote speaker diarization
    - Implement `TranscriptionPipeline.diarize()` — run pyannote on audio file
    - Return `DiarizationResult` with speaker segments and time ranges
    - _Requirements: 6.1_

  - [x] 8.4 Implement segment-speaker alignment
    - Implement `TranscriptionPipeline.align()` — align Whisper segments with pyannote speaker segments
    - Every Whisper segment must be assigned exactly one speaker label — no orphaned segments
    - Produce `TranscriptEntry[]` with `speaker`, `text`, `timestamp` (ISO 8601), ordered chronologically
    - _Requirements: 6.2, 6.3, 8.1, 8.2_

  - [ ]* 8.5 Write property test for segment-speaker alignment completeness
    - **Property 7: Segment-speaker alignment completeness**
    - **Validates: Requirement 6.2**

  - [ ]* 8.6 Write property test for Transcript_JSON schema validity
    - **Property 8: Transcript_JSON schema validity**
    - **Validates: Requirements 6.3, 8.1**

  - [ ]* 8.7 Write property test for Transcript_JSON chronological ordering
    - **Property 9: Transcript_JSON chronological ordering**
    - **Validates: Requirements 8.2, 12.3**

  - [ ]* 8.8 Write property test for Transcript_JSON round-trip serialization
    - **Property 10: Transcript_JSON round-trip serialization**
    - **Validates: Requirement 8.3**

  - [x] 8.9 Implement pipeline error handling
    - Whisper failure → log error, mark `transcription_failed` (Req 5.4)
    - Pyannote failure → log error, mark `transcription_failed` (Req 6.6)
    - GPU preemption detection → re-enqueue Cloud Tasks job, increment `retryCount` (Req 5.5, 6.7)
    - Audio deletion after transcription → retry up to 3×, alert operator on final failure (Req 7.1, 7.2, 7.3)
    - _Requirements: 5.4, 5.5, 6.6, 6.7, 7.1, 7.2, 7.3_

  - [x] 8.10 Implement Transcript_JSON upload and status update
    - Upload Transcript_JSON to `gs://leverege-notetaker-transcripts/{owning_user_hash}/{meeting_id}/transcript.json`
    - Update Cloud SQL: set `transcription_status = 'completed'`, set `transcript_location`
    - Delete raw audio from `gs://leverege-notetaker-audio/{owning_user_hash}/{meeting_id}/audio.wav`
    - Confirm deletion before finalizing status
    - Self-shutdown instance via `gcloud compute instances delete --self`
    - _Requirements: 6.4, 6.5, 7.1, 7.2_

  - [ ]* 8.11 Write unit tests for transcription pipeline
    - Test Whisper failure → status `transcription_failed` (Req 5.4)
    - Test pyannote failure → status `transcription_failed` (Req 6.6)
    - Test audio deletion retry — 3 retries then operator alert (Req 7.3)
    - _Requirements: 5.4, 6.6, 7.3_

- [x] 9. Checkpoint — Transcription pipeline complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. React Web UI (Phase 1)
  - [x] 10.1 Set up React app with routing and auth integration
    - Create React app served via Cloud Run
    - Implement Google SSO login redirect for unauthenticated users
    - Set up React Router with routes: `/` (meeting list), `/meetings/:id` (transcript view)
    - Implement auth context provider that calls `GET /api/auth/me`
    - _Requirements: 13.1, 13.2_

  - [x] 10.2 Implement meeting submission form
    - Create `MeetingSubmitForm` component — text input for meeting link, submit button
    - On submit: `POST /api/meetings` with the meeting link
    - Display validation errors for unsupported URLs
    - _Requirements: 10.1, 10.2_

  - [x] 10.3 Implement meeting list view
    - Create `MeetingList` component — fetch `GET /api/meetings`, display list of meetings
    - Render meeting title, platform, date, and transcription status for each meeting
    - Click a meeting to navigate to transcript view
    - Only shows meetings owned by authenticated user (enforced by API)
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 10.4 Write property test for meeting list renders required fields
    - **Property 13: Meeting list renders required fields**
    - **Validates: Requirement 11.2**

  - [x] 10.5 Implement transcript view
    - Create `TranscriptView` component — fetch `GET /api/meetings/:id/transcript`, display speaker-attributed transcript
    - Visually distinguish different speakers (color coding or labels)
    - Display entries in chronological order (already sorted by API)
    - Show transcription status if transcript not yet available
    - _Requirements: 12.1, 12.2, 12.3, 12.5_

  - [ ]* 10.6 Write property test for transcript view renders required fields
    - **Property 14: Transcript view renders required fields**
    - **Validates: Requirement 12.1**

  - [x] 10.7 Implement speaker label rename
    - Add inline rename UI on speaker labels in transcript view
    - On rename: `PATCH /api/meetings/:id/speakers` with `{ originalLabel, customLabel }`
    - Update local state to reflect rename immediately
    - _Requirements: 12.4_

  - [x] 10.8 Implement bot status banner with SSE
    - Create `BotStatusBanner` component — subscribe to `GET /api/meetings/:id/status` SSE stream
    - Display real-time bot status: joining, waiting_room, in_meeting, capturing, uploading, completed, failed
    - Show waiting room admission prompt when status is `waiting_room`
    - _Requirements: 10.3, 1.9_

  - [ ]* 10.9 Write unit tests for UI components
    - Test meeting list rendering
    - Test transcript view rendering
    - Test bot status banner SSE subscription
    - _Requirements: 11.2, 12.1, 10.3_

- [x] 11. Checkpoint — Phase 1 complete (internal Google Meet + transcription + UI)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Bot Orchestrator and Playwright Bot (Phase 2 — Zoom)
  - [x] 12.1 Implement Bot Orchestrator service
    - Create Cloud Run service for bot lifecycle management
    - Implement `dispatchBot()` — spawn Playwright bot process, track session
    - Implement `getBotStatus()` — return current bot status for a meeting
    - Implement `stopBot()` — signal bot to leave meeting and finalize capture
    - Implement `streamStatus()` — SSE stream pushing bot status updates to Backend API
    - _Requirements: 1.1, 1.8_

  - [x] 12.2 Implement Playwright Bot core — meeting join and audio capture
    - Implement `MeetingBot.join()` — launch headless Playwright browser, navigate to meeting URL, authenticate with platform credentials from Secret Manager
    - Implement `MeetingBot.startCapture()` — capture audio stream using Chrome DevTools Protocol (CDP) MediaRecorder on the Playwright Chromium session. Launch Chromium with `--use-fake-ui-for-media-stream` flag to enable virtual audio capture. Pipe the browser's incoming meeting audio stream to a WAV/FLAC file at 16kHz sample rate. No system audio card or display required — audio is sourced from the platform's WebRTC stream delivered to the headless browser session.
    - Implement `MeetingBot.stopCapture()` — finalize audio buffer
    - Implement `MeetingBot.leave()` — leave meeting, close browser
    - _Requirements: 1.1, 1.3, 1.7_

  - [ ]* 12.3 Write property test for audio capture format invariant
    - **Property 2: Audio capture format invariant**
    - **Validates: Requirement 1.7**

  - [x] 12.4 Implement Google Meet bot join flow (external meetings)
    - Authenticate as `notetaker@leverege.com` Google Workspace service account
    - Fetch credentials from Secret Manager
    - Handle Google Meet-specific UI elements for joining
    - _Requirements: 1.3, 1.6_

  - [x] 12.5 Implement Zoom bot join flow
    - Authenticate using Zoom account linked to service account email
    - Fetch credentials from Secret Manager
    - Handle Zoom web client UI elements for joining
    - _Requirements: 1.4, 1.6_

  - [x] 12.6 Implement waiting room handling and timeouts
    - Detect waiting room / admission gate across platforms
    - Notify user via SSE when bot is in waiting room
    - Wait up to 5 minutes for admission, then timeout
    - Implement 60-second join timeout (excluding waiting room wait)
    - Log failure reasons and notify user on timeout
    - _Requirements: 1.9, 1.10_

  - [x] 12.7 Implement audio upload to Cloud Storage
    - Upload captured audio to `gs://leverege-notetaker-audio/{owning_user_hash}/{meeting_id}/audio.wav`
    - Include `meeting_id` and `owning_user` in upload metadata
    - Retry upload up to 3× with exponential backoff
    - Log failure and notify user if all retries fail
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 12.8 Write property test for upload metadata includes required fields
    - **Property 4: Upload metadata includes required fields**
    - **Validates: Requirement 3.2**

  - [x] 12.9 Wire bot dispatch into Backend API
    - Update `POST /api/meetings` to dispatch bot via Bot Orchestrator for external meetings
    - Implement `GET /api/meetings/:id/status` SSE endpoint forwarding bot status from orchestrator
    - _Requirements: 10.2, 10.3_

  - [ ]* 12.10 Write unit tests for bot layer
    - Test waiting room detection and 5-minute timeout (Req 1.9)
    - Test join timeout at 60 seconds (Req 1.10)
    - Test upload retry with exponential backoff — 3 retries then failure (Req 3.3, 3.4)
    - Test platform credential selection per meeting URL (Req 1.3–1.5)
    - _Requirements: 1.3–1.5, 1.9, 1.10, 3.3, 3.4_

- [x] 13. Checkpoint — Phase 2 complete (Zoom bot)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Microsoft Teams bot integration (Phase 3)
  - [x] 14.1 Implement Teams bot join flow
    - Authenticate using dedicated Microsoft account identity
    - Fetch credentials from Secret Manager
    - Handle Teams-specific UI elements and lobby admission
    - _Requirements: 1.2, 1.5, 1.6_

  - [ ]* 14.2 Write unit tests for Teams bot join
    - Test Teams credential selection
    - Test Teams lobby handling
    - _Requirements: 1.5, 1.9_

- [x] 15. Per-user data scoping and encryption verification
  - [x] 15.1 Implement Cloud Storage per-user path scoping
    - Use SHA-256 hash of owning user email as path prefix: `{owning_user_hash}/{meeting_id}/`
    - Enforce path scoping at both API layer (construct paths from authenticated user) and Cloud Storage access layer
    - Ensure transcripts and audio files are never logged or stored in plaintext in intermediate layers
    - _Requirements: 14.1, 14.4, 14.5_

  - [x] 15.2 Verify encryption at rest configuration
    - Verify Cloud Storage encryption at rest (Google-managed or CMEK) for audio and transcript buckets
    - Verify Cloud SQL encryption at rest for metadata store
    - _Requirements: 15.1, 15.2, 15.3_

- [ ] 16. Integration tests
  - [ ]* 16.1 Write integration tests for bot-to-transcript pipeline
    - Test: bot dispatch → audio upload → Eventarc → Cloud Tasks → T4 instance → transcript available
    - Test: meeting submission → metadata creation → bot dispatch → SSE status stream
    - _Requirements: 1.1, 3.1, 4.1, 5.1, 6.4_

  - [ ]* 16.2 Write integration tests for Workspace Events flow
    - Test: Workspace Events API → transcript conversion → storage → metadata creation
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 16.3 Write integration tests for authentication flow
    - Test: login → session → protected endpoint → logout → redirect
    - _Requirements: 13.1–13.5_

- [x] 17. Final checkpoint — All phases complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties (fast-check for TS, Hypothesis for Python)
- Unit tests validate specific examples and edge cases
- Phase 4 (calendar integration) is deferred to v2 per requirements and is not included in this task list
- Privacy constraint: transcripts, audio files, and meeting links must never appear in application logs or error reports at any layer
