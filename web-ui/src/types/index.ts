// ============================================================
// Web UI Types — Leverege Meeting Notetaker
// ============================================================

export type Platform = 'google_meet' | 'zoom' | 'teams';

export type TranscriptionStatus =
    | 'pending'
    | 'transcription_pending'
    | 'processing'
    | 'completed'
    | 'transcription_failed';

export type BotSessionStatus =
    | 'joining'
    | 'waiting_room'
    | 'in_meeting'
    | 'capturing'
    | 'uploading'
    | 'completed'
    | 'failed';

export interface TranscriptEntry {
    speaker: string;
    text: string;
    /** ISO 8601 string */
    timestamp: string;
}

export interface MeetingMetadata {
    meetingId: string;
    title: string;
    platform: Platform;
    startTime?: string;
    endTime?: string;
    transcriptLocation?: string;
    owningUser: string;
    transcriptionStatus: TranscriptionStatus;
    createdAt: string;
    updatedAt: string;
}

export interface BotStatus {
    status: BotSessionStatus;
    waitingRoomSince?: Date;
    error?: string;
}

export interface User {
    email: string;
    name: string;
    picture?: string;
}
