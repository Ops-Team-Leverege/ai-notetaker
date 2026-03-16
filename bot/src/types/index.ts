// ============================================================
// Bot Types — Leverege Meeting Notetaker
// ============================================================

export type Platform = 'google_meet' | 'zoom' | 'teams';

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

export interface TranscriptEntry {
    speaker: string;
    text: string;
    /** ISO 8601 string */
    timestamp: string;
}
