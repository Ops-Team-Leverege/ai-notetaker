-- Migration 003: Create sessions table
-- Requirements: 13.3, 13.5 — Session management and cleanup

CREATE TABLE IF NOT EXISTS sessions (
    token       VARCHAR(256) PRIMARY KEY,
    user_email  VARCHAR(320) NOT NULL,
    user_name   VARCHAR(200) NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
