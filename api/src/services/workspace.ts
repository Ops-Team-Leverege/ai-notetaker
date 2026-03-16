import { createHash } from 'crypto';
import { Storage } from '@google-cloud/storage';
import { getPool } from '../db';
import { TranscriptEntry } from '../types';
import { mapRowToMeetingMetadata } from './meetings';
import type { MeetingMetadata } from '../types';

const TRANSCRIPT_BUCKET = process.env.TRANSCRIPT_BUCKET || 'leverege-notetaker-transcripts';

/**
 * Workspace Events API event payload shape.
 */
export interface WorkspaceEvent {
    type: string;
    meetingId: string;
    organizer: string;
    title: string;
    startTime: string;
    endTime: string;
    transcript?: WorkspaceTranscriptEntry[];
}

export interface WorkspaceTranscriptEntry {
    participantName: string;
    text: string;
    startTime: string;
}

/**
 * Pure function: convert Workspace transcript entries to TranscriptEntry[].
 * Maps participantName → speaker, text → text, startTime → timestamp (ISO 8601).
 */
export function convertTranscript(
    workspaceTranscript: WorkspaceTranscriptEntry[],
): TranscriptEntry[] {
    return workspaceTranscript.map((entry) => ({
        speaker: entry.participantName,
        text: entry.text,
        timestamp: entry.startTime,
    }));
}

/**
 * Compute SHA-256 hash of a user's email for Cloud Storage path scoping.
 */
export function hashUserEmail(email: string): string {
    return createHash('sha256').update(email).digest('hex');
}

/**
 * Orchestrate handling of a meeting.ended event:
 * 1. Convert transcript to TranscriptEntry[]
 * 2. Upload Transcript_JSON to Cloud Storage
 * 3. Create meeting metadata record in Cloud SQL with status 'completed'
 *
 * Throws on GCS upload or Cloud SQL insert failure.
 */
export async function handleMeetingCompleted(event: WorkspaceEvent): Promise<MeetingMetadata> {
    const transcript = convertTranscript(event.transcript || []);

    const ownerHash = hashUserEmail(event.organizer);
    const gcsPath = `${ownerHash}/${event.meetingId}/transcript.json`;
    const gcsUri = `gs://${TRANSCRIPT_BUCKET}/${gcsPath}`;

    // Upload Transcript_JSON to Cloud Storage
    const storage = new Storage();
    await storage
        .bucket(TRANSCRIPT_BUCKET)
        .file(gcsPath)
        .save(JSON.stringify(transcript), {
            contentType: 'application/json',
        });

    // Create meeting metadata record in Cloud SQL
    const pool = getPool();
    const result = await pool.query(
        `INSERT INTO meetings (meeting_id, title, platform, start_time, end_time,
                               transcript_location, owning_user, transcription_status)
         VALUES ($1, $2, 'google_meet', $3, $4, $5, $6, 'completed')
         RETURNING meeting_id, title, platform, start_time, end_time,
                   transcript_location, owning_user, transcription_status,
                   meeting_link, created_at, updated_at`,
        [
            event.meetingId,
            event.title,
            event.startTime,
            event.endTime,
            gcsUri,
            event.organizer,
        ],
    );

    return mapRowToMeetingMetadata(result.rows[0]);
}
