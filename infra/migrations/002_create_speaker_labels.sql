-- Migration 002: Create speaker_labels table
-- Requirements: 12.4 — Speaker label rename persistence

CREATE TABLE IF NOT EXISTS speaker_labels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id      UUID NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
    original_label  VARCHAR(100) NOT NULL,
    custom_label    VARCHAR(200),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(meeting_id, original_label)
);
