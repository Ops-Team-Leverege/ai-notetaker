# Leverege Meeting Notetaker

## Requirements Document

Version 1.0 · GCP Deployment · Confidential

## Introduction

A meeting notetaker system deployed on Google Cloud Platform that captures audio from meetings (Google Meet, Zoom, Microsoft Teams), transcribes the audio with speaker attribution, and presents speaker-attributed transcripts through a React web UI.

The system uses two capture strategies:

- A Playwright headless bot authenticated as the notetaker@leverege.com Google Workspace service account, used for Zoom, Teams, and external Google Meet sessions
- The Google Workspace Events API for internal Google Meet meetings, eliminating the need for a bot on meetings hosted within the Leverege organization

Transcription is performed by self-hosted Whisper model (open source, running on T4 GPU instance within GCP) with pyannote speaker diarization on preemptible T4 GPU instances. All data is encrypted at rest, private by default, and scoped per user. No LLM summarization is performed.

## Glossary

| Term | Definition |
|------|-----------|
| **Bot** | A Playwright headless browser instance authenticated as the Leverege Notetaker service account that joins a meeting link, captures audio, and uploads it to Cloud Storage |
| **Service_Account** | The designated Google Workspace service account (notetaker@leverege.com) used as the bot identity across all platform integrations. Must be added to meeting invites by the user prior to meeting start |
| **Notetaker_Identity** | The platform-specific identity the bot uses to join meetings: the Google service account for Google Meet, a linked Zoom account for Zoom meetings, and a dedicated Microsoft account for Teams meetings |
| **Workspace_Events_API** | The Google Workspace Events API used to pull transcripts directly from internal Google Meet sessions without a bot |
| **Transcription_Pipeline** | The Cloud Tasks-triggered job that runs the self-hosted Whisper open source model for transcription and pyannote speaker diarization on a preemptible T4 GPU instance |
| **Transcript_JSON** | A JSON document stored in Cloud Storage containing an array of objects, each with `speaker`, `text`, and `timestamp` fields |
| **Metadata_Store** | A Cloud SQL database that stores meeting metadata such as meeting ID, title, participants, timestamps, transcript location, and owning user |
| **Web_UI** | A React application served via Cloud Run that displays the meeting list and speaker-attributed transcripts |
| **Auth_Service** | The Google SSO-based authentication layer that identifies users and enforces per-user data scoping |
| **Cloud_Storage** | Google Cloud Storage buckets used to store raw audio files and Transcript_JSON output |
| **Meeting_Link** | A URL pointing to a Google Meet, Zoom, or Microsoft Teams meeting session |
| **Internal_Google_Meet** | A Google Meet session hosted within the Leverege Google Workspace organization |
| **External_Meeting** | A Zoom, Microsoft Teams, or non-organizational Google Meet session requiring the Bot to join |
| **Waiting_Room** | A platform-controlled admission gate (Zoom waiting room, Teams lobby) that requires host action before participants can enter |

## Requirements

### Requirement 1 — Bot Meeting Join & Service Account Identity

**User Story:** As a user, I want a headless bot to join my Zoom, Teams, or external Google Meet sessions using a trusted Leverege service account, so that audio can be captured without manual intervention and participants can identify the notetaker.

#### Acceptance Criteria

1. WHEN a user provides a Meeting_Link for an External_Meeting, THE Bot SHALL join the meeting authenticated as the designated Leverege Notetaker Service_Account
2. THE Bot SHALL support joining Google Meet, Zoom, and Microsoft Teams Meeting_Links
3. FOR Google Meet sessions, THE Bot SHALL authenticate using the Google Workspace service account (notetaker@leverege.com) with credentials stored in Secret Manager
4. FOR Zoom meetings, THE Bot SHALL authenticate using a Zoom account linked to the service account email, with credentials stored in Secret Manager
5. FOR Microsoft Teams meetings, THE Bot SHALL authenticate using a dedicated Microsoft account identity, with credentials stored in Secret Manager
6. THE user SHALL add the Service_Account to the meeting invite prior to meeting start so that the bot is admitted as an expected participant
7. WHEN the Bot joins a meeting, THE Bot SHALL capture the meeting audio stream in WAV or FLAC format at 16kHz sample rate for the duration of the session
8. WHEN the meeting ends or the user requests stop, THE Bot SHALL leave the meeting and finalize the audio capture
9. IF the Bot encounters a Waiting_Room or admission gate, THE Bot SHALL notify the user via the Web_UI and wait up to 5 minutes for admission before timing out
10. IF the Bot fails to join a meeting within 60 seconds (excluding Waiting_Room wait time), THEN THE Bot SHALL log the failure reason and notify the user via the Web_UI

### Requirement 2 — Internal Google Meet Transcript Capture

**User Story:** As a user with an Internal_Google_Meet, I want transcripts pulled directly via the Workspace Events API, so that no bot is needed for internal meetings.

#### Acceptance Criteria

1. WHEN an Internal_Google_Meet session completes, THE Workspace_Events_API integration SHALL retrieve the transcript data from Google Workspace
2. THE Workspace_Events_API integration SHALL convert the retrieved transcript into Transcript_JSON format with `speaker`, `text`, and `timestamp` fields
3. WHEN the Transcript_JSON is generated, THE Workspace_Events_API integration SHALL upload the Transcript_JSON to Cloud_Storage
4. WHEN the Transcript_JSON is stored, THE Workspace_Events_API integration SHALL create a corresponding metadata record in the Metadata_Store
5. IF the Workspace_Events_API returns an error or the transcript is unavailable, THEN THE Workspace_Events_API integration SHALL log the error and notify the user via the Web_UI

### Requirement 3 — Audio Upload to Cloud Storage

**User Story:** As a system operator, I want captured audio uploaded to Cloud Storage, so that it is durably stored and available for the transcription pipeline.

#### Acceptance Criteria

1. WHEN the Bot finishes capturing audio from an External_Meeting, THE Bot SHALL upload the audio file to Cloud_Storage in WAV or FLAC format at 16kHz sample rate
2. THE Bot SHALL associate each uploaded audio file with the meeting ID and owning user in the upload metadata
3. IF the audio upload to Cloud_Storage fails, THEN THE Bot SHALL retry the upload up to 3 times with exponential backoff
4. IF all upload retries fail, THEN THE Bot SHALL log the failure and notify the user via the Web_UI

### Requirement 4 — Transcription Pipeline Trigger

**User Story:** As a system operator, I want audio uploads to automatically trigger transcription jobs, so that transcripts are produced without manual intervention.

#### Acceptance Criteria

1. WHEN an audio file is uploaded to Cloud_Storage, THE system SHALL create a Cloud Tasks job to process the audio file
2. THE Cloud Tasks job SHALL specify the audio file location, meeting ID, and owning user as task parameters
3. IF Cloud Tasks job creation fails, THEN THE system SHALL retry job creation up to 3 times with exponential backoff
4. IF all Cloud Tasks retries fail, THEN THE system SHALL log the failure and mark the meeting as `transcription_pending` in the Metadata_Store
5. THE system SHALL limit concurrent active Transcription_Pipeline jobs to a configurable maximum (default: 5) to prevent unbounded GPU instance spin-up

### Requirement 5 — Whisper Transcription

**User Story:** As a user, I want my meeting audio transcribed accurately, so that a full text record of the meeting is produced.

#### Acceptance Criteria

1. WHEN a Cloud Tasks transcription job executes, THE Transcription_Pipeline SHALL run the self-hosted Whisper model (open source, not the OpenAI API — audio must not leave GCP) for transcription on the audio file
2. THE Transcription_Pipeline SHALL execute Whisper on a preemptible T4 GPU instance
3. WHEN Whisper transcription completes, THE Transcription_Pipeline SHALL pass the transcription output to the pyannote diarization stage
4. IF Whisper processing fails, THEN THE Transcription_Pipeline SHALL log the error and mark the meeting as `transcription_failed` in the Metadata_Store
5. IF the preemptible T4 GPU instance is preempted during Whisper processing, THEN THE Transcription_Pipeline SHALL re-enqueue the Cloud Tasks job, up to a maximum of 5 retries before marking the meeting as `transcription_failed`

### Requirement 6 — Pyannote Speaker Diarization

**User Story:** As a user, I want speaker attribution applied to my transcript, so that I can see who said what during the meeting.

#### Acceptance Criteria

1. WHEN Whisper transcription output is available, THE Transcription_Pipeline SHALL run pyannote speaker diarization on the audio file
2. THE Transcription_Pipeline SHALL align pyannote diarization segments with Whisper transcription output to produce speaker-attributed transcript entries
3. THE Transcription_Pipeline SHALL produce a Transcript_JSON containing an array of objects, each with `speaker` (string), `text` (string), and `timestamp` (ISO 8601 string) fields
4. WHEN diarization completes, THE Transcription_Pipeline SHALL upload the Transcript_JSON to Cloud_Storage
5. WHEN diarization completes, THE Transcription_Pipeline SHALL update the meeting metadata in the Metadata_Store with the transcript location and status `completed`
6. IF pyannote diarization fails, THEN THE Transcription_Pipeline SHALL log the error and mark the meeting as `transcription_failed` in the Metadata_Store
7. IF the preemptible T4 GPU instance is preempted during diarization, THEN THE Transcription_Pipeline SHALL re-enqueue the Cloud Tasks job, up to a maximum of 5 retries before marking the meeting as `transcription_failed`

### Requirement 7 — Audio File Deletion After Transcription

**User Story:** As a user, I want raw audio files deleted after transcription completes, so that sensitive audio is not retained longer than necessary.

#### Acceptance Criteria

1. WHEN transcription status is set to `completed`, THE system SHALL delete the raw audio file from Cloud_Storage
2. THE system SHALL confirm deletion before updating the meeting status to `completed` in the Metadata_Store
3. IF audio file deletion fails, THE system SHALL log the failure and retry deletion up to 3 times before alerting the system operator

### Requirement 8 — Transcript JSON Format

**User Story:** As a developer, I want a well-defined transcript output format, so that the Web_UI and any future consumers can reliably parse transcripts.

#### Acceptance Criteria

1. THE Transcription_Pipeline SHALL output Transcript_JSON where each entry contains a `speaker` field (string), a `text` field (string), and a `timestamp` field (ISO 8601 formatted string)
2. THE Transcription_Pipeline SHALL order entries in the Transcript_JSON chronologically by `timestamp`
3. FOR ALL valid Transcript_JSON documents, parsing then serializing then parsing the document SHALL produce an equivalent object (round-trip property)

#### Example Transcript_JSON

```json
[
  {
    "speaker": "Speaker 1",
    "text": "Let's kick off with a quick status update.",
    "timestamp": "2026-03-13T14:00:05Z"
  },
  {
    "speaker": "Speaker 2",
    "text": "Sure, we finished the API integration yesterday.",
    "timestamp": "2026-03-13T14:00:12Z"
  }
]
```

### Requirement 9 — Meeting Metadata Storage

**User Story:** As a user, I want meeting metadata stored reliably, so that I can browse and search my past meetings.

#### Acceptance Criteria

1. WHEN a meeting is captured (via Bot or Workspace_Events_API), THE system SHALL create a metadata record in the Metadata_Store containing meeting ID, title, platform, start time, end time, transcript location, owning user, and transcription status
2. THE Metadata_Store SHALL associate each meeting record with exactly one owning user
3. WHEN transcription status changes, THE system SHALL update the corresponding metadata record in the Metadata_Store

#### Metadata Schema

```json
{
  "meeting_id": "string (uuid)",
  "title": "string",
  "platform": "google_meet | zoom | teams",
  "start_time": "ISO 8601 string",
  "end_time": "ISO 8601 string",
  "transcript_location": "gs://bucket/path/to/transcript.json",
  "owning_user": "string (email)",
  "transcription_status": "pending | transcription_pending | processing | completed | transcription_failed"
}
```

### Requirement 10 — Web UI: Meeting Submission

**User Story:** As a user, I want to submit a meeting link via the web interface, so that I can trigger bot capture for external meetings.

#### Acceptance Criteria

1. THE Web_UI SHALL provide a form for the authenticated user to submit a Meeting_Link for bot capture
2. WHEN a Meeting_Link is submitted, THE Web_UI SHALL create a meeting record in the Metadata_Store with status `pending` and dispatch the Bot to join the meeting
3. THE Web_UI SHALL display the current bot join status and any Waiting_Room admission prompts to the user in real time

### Requirement 11 — Web UI: Meeting List

**User Story:** As a user, I want to see a list of my meetings in a web interface, so that I can find and review past meeting transcripts.

#### Acceptance Criteria

1. WHEN an authenticated user navigates to the meeting list page, THE Web_UI SHALL display a list of meetings owned by that user
2. THE Web_UI SHALL display the meeting title, platform, date, and transcription status for each meeting in the list
3. THE Web_UI SHALL only display meetings owned by the authenticated user
4. WHEN a user selects a meeting from the list, THE Web_UI SHALL navigate to the transcript view for that meeting

### Requirement 12 — Web UI: Transcript View

**User Story:** As a user, I want to view speaker-attributed transcripts, so that I can review who said what during a meeting.

#### Acceptance Criteria

1. WHEN an authenticated user navigates to a transcript view, THE Web_UI SHALL display the Transcript_JSON content with speaker labels, text, and timestamps
2. THE Web_UI SHALL visually distinguish different speakers in the transcript
3. THE Web_UI SHALL display transcript entries in chronological order
4. THE Web_UI SHALL allow the authenticated user to rename speaker labels (e.g. `Speaker 1` → `John Smith`) and persist the updated labels to the Metadata_Store
5. IF the transcript is not yet available (status is not `completed`), THEN THE Web_UI SHALL display the current transcription status to the user

### Requirement 13 — Authentication via Google SSO

**User Story:** As a user, I want to sign in with my Google account, so that I can securely access my meeting data.

#### Acceptance Criteria

1. THE Auth_Service SHALL authenticate users via Google SSO (OAuth 2.0 / OpenID Connect)
2. WHEN an unauthenticated user accesses the Web_UI, THE Auth_Service SHALL redirect the user to the Google SSO login flow
3. WHEN a user completes Google SSO login, THE Auth_Service SHALL create a session and redirect the user to the Web_UI
4. WHEN a user requests logout, THE Auth_Service SHALL invalidate the user session and redirect to the login page
5. IF a session token is expired or invalid, THEN THE Auth_Service SHALL redirect the user to the Google SSO login flow

### Requirement 14 — Per-User Data Scoping

**User Story:** As a user, I want my meeting data to be private and only accessible to me, so that my meeting content is secure.

#### Acceptance Criteria

1. THE system SHALL scope all meeting data (audio, Transcript_JSON, metadata) to the owning user
2. WHEN a user requests meeting data, THE system SHALL verify that the authenticated user is the owning user before returning data
3. IF a user requests data for a meeting they do not own, THEN THE system SHALL deny the request and return an authorization error
4. THE system SHALL enforce per-user scoping at both the Web_UI API layer and the Cloud_Storage access layer
5. Transcripts and audio files SHALL NOT be logged or stored in plaintext in any intermediate layer, including application logs, error reports, or webhook payload caches

### Requirement 15 — Data Encryption at Rest

**User Story:** As a user, I want all my meeting data encrypted at rest, so that my data is protected from unauthorized access.

#### Acceptance Criteria

1. THE Cloud_Storage SHALL encrypt all stored audio files and Transcript_JSON documents at rest using Google-managed encryption keys or customer-managed encryption keys
2. THE Metadata_Store SHALL encrypt all stored meeting metadata at rest
3. THE system SHALL ensure encryption at rest is enabled for all data stores before accepting any meeting data

## Implementation Notes

### GCP Services

| Service | Purpose |
|---------|---------|
| Cloud Run | Web UI and backend API |
| Cloud Tasks | Transcription job queue |
| Cloud Storage | Audio files and Transcript_JSON |
| Cloud SQL | Metadata_Store |
| Secret Manager | All credentials (service account keys, Zoom, Teams identities) |
| Compute Engine (preemptible T4 GPU) | Whisper + pyannote processing |

### Bot Identity Per Platform

| Platform | Identity | Notes |
|----------|----------|-------|
| Google Meet (internal) | notetaker@leverege.com (Google service account) | Workspace Events API — no bot needed |
| Google Meet (external) | notetaker@leverege.com (Google service account) | Bot joins as invited participant |
| Zoom | Zoom account linked to service account email | Must be added to invite by user |
| Microsoft Teams | Dedicated Microsoft account identity | Separate from Google identity; Teams treats Google accounts as guests |

### Build Phases

| Phase | Scope |
|-------|-------|
| Phase 1 | Google Meet (internal) via Workspace Events API + transcription pipeline + basic UI |
| Phase 2 | Zoom bot integration |
| Phase 3 | Microsoft Teams bot integration |
| Phase 4 (v2) | Calendar integration for automatic meeting detection |

### Privacy Constraints

> ⚠️ **Critical:** Transcripts and audio files must never appear in application logs, error reports, or any intermediate plaintext store at any layer of the pipeline.

- Raw audio files are deleted immediately after `transcription_completed` status is confirmed
- All credentials stored exclusively in Secret Manager — never in environment variables or source code
- No LLM summarization — transcripts stay within Leverege infrastructure
- Per-user data scoping enforced at both API and Cloud Storage layers
- Whisper runs as a self-hosted open source model on the T4 GPU instance — the OpenAI Whisper API must never be used as it would send audio to external servers
