-- Migration 004: Add bot lifecycle statuses to meetings constraint
-- The bot dispatch uses 'joining' and 'failed' which weren't in the original constraint.

ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_transcription_status_check;

ALTER TABLE meetings ADD CONSTRAINT meetings_transcription_status_check
    CHECK (transcription_status IN (
        'pending', 'joining', 'transcription_pending', 'processing',
        'completed', 'failed', 'transcription_failed'
    ));
