// ============================================================
// Core Types — Leverege Meeting Notetaker
// ============================================================

// --- Platform & Status Enums ---

export type Platform = 'google_meet' | 'zoom' | 'teams';

export type TranscriptionStatus =
    | 'pending'
    | 'joining'
    | 'transcription_pending'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'transcription_failed';

// --- Transcript ---

export interface TranscriptEntry {
    speaker: string;
    text: string;
    /** ISO 8601 string, e.g. "2026-03-13T14:00:05Z" */
    timestamp: string;
}

// --- Meeting Metadata ---

export interface MeetingMetadata {
    meetingId: string;
    title: string;
    platform: Platform;
    startTime?: string;
    endTime?: string;
    transcriptLocation?: string;
    owningUser: string;
    transcriptionStatus: TranscriptionStatus;
    meetingLink?: string;
    createdAt: string;
    updatedAt: string;
}

// --- Cloud Tasks Job Payload ---

export interface TranscriptionTask {
    meetingId: string;
    /** gs://bucket/path/to/audio.wav */
    audioGcsPath: string;
    /** email */
    owningUser: string;
    /**
     * 0-based retry count.
     * Handler checks retryCount >= 4 before processing.
     * Max 5 attempts total (retryCount 0–4).
     */
    retryCount: number;
}

// --- Bot ---

export type BotSessionStatus =
    | 'joining'
    | 'waiting_room'
    | 'in_meeting'
    | 'capturing'
    | 'uploading'
    | 'completed'
    | 'failed';

export interface BotSession {
    meetingId: string;
    status: BotSessionStatus;
    startedAt: Date;
    platform: Platform;
}

export interface BotStatus {
    status: BotSessionStatus;
    waitingRoomSince?: Date;
    error?: string;
}

export interface PlatformCredentials {
    platform: Platform;
    /** Fetched from Secret Manager at runtime */
    credentials: Record<string, string>;
}

export interface AudioBuffer {
    data: Buffer;
    format: 'wav' | 'flac';
    sampleRate: 16000;
    durationSeconds: number;
}

// --- Auth ---

export interface Session {
    token: string;
    user: User;
    expiresAt: Date;
}

export interface User {
    email: string;
    name: string;
    picture?: string;
}
