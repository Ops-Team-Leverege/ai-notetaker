-- Migration 001: Create meetings table
-- Requirements: 9.1, 9.2 — Meeting metadata storage

CREATE TABLE IF NOT EXISTS meetings (
    meeting_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title                VARCHAR(500)  NOT NULL,
    platform             VARCHAR(20)   NOT NULL CHECK (platform IN ('google_meet', 'zoom', 'teams')),
    start_time           TIMESTAMPTZ,
    end_time             TIMESTAMPTZ,
    transcript_location  TEXT,
    owning_user          VARCHAR(320)  NOT NULL,
    transcription_status VARCHAR(30)   NOT NULL DEFAULT 'pending'
        CHECK (transcription_status IN (
            'pending', 'transcription_pending', 'processing',
            'completed', 'transcription_failed'
        )),
    meeting_link         TEXT,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meetings_owning_user ON meetings(owning_user);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(transcription_status);
