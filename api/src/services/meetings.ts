import { getPool } from '../db';
import { Storage } from '@google-cloud/storage';
import { Platform, MeetingMetadata, TranscriptEntry } from '../types';

/**
 * List meetings owned by a specific user, ordered by created_at DESC.
 */
export async function listMeetings(owningUser: string): Promise<MeetingMetadata[]> {
    const pool = getPool();
    const result = await pool.query(
        `SELECT meeting_id, title, platform, start_time, end_time,
                transcript_location, owning_user, transcription_status,
                meeting_link, created_at, updated_at
         FROM meetings
         WHERE owning_user = $1
         ORDER BY created_at DESC`,
        [owningUser],
    );
    return result.rows.map(mapRowToMeetingMetadata);
}

/**
 * Get a single meeting by ID.
 * Returns null if not found.
 */
export async function getMeetingById(meetingId: string): Promise<MeetingMetadata | null> {
    const pool = getPool();
    const result = await pool.query(
        `SELECT meeting_id, title, platform, start_time, end_time,
                transcript_location, owning_user, transcription_status,
                meeting_link, created_at, updated_at
         FROM meetings
         WHERE meeting_id = $1`,
        [meetingId],
    );
    if (result.rows.length === 0) {
        return null;
    }
    return mapRowToMeetingMetadata(result.rows[0]);
}

/**
 * Detect the meeting platform from a URL.
 * Supports Google Meet, Zoom, and Microsoft Teams.
 * Throws on unsupported URLs.
 */
export function detectPlatform(url: string): Platform {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Invalid URL');
    }

    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    // Google Meet: meet.google.com/*
    if (hostname === 'meet.google.com') {
        return 'google_meet';
    }

    // Zoom: zoom.us/j/*, *.zoom.us/j/*
    if (
        (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) &&
        pathname.startsWith('/j/')
    ) {
        return 'zoom';
    }

    // Microsoft Teams: teams.microsoft.com/l/meetup-join/*, teams.live.com/meet/*
    if (
        (hostname === 'teams.microsoft.com' && pathname.startsWith('/l/meetup-join/')) ||
        (hostname === 'teams.live.com' && pathname.startsWith('/meet/'))
    ) {
        return 'teams';
    }

    throw new Error('Unsupported meeting platform');
}

/**
 * Create a meeting record in Cloud SQL.
 * Validates the URL, detects platform, inserts with status 'pending'.
 */
export async function createMeeting(
    meetingLink: string,
    owningUser: string,
): Promise<MeetingMetadata> {
    const platform = detectPlatform(meetingLink);

    const title = `${formatPlatformName(platform)} meeting — ${new Date().toISOString()}`;

    const pool = getPool();
    const result = await pool.query(
        `INSERT INTO meetings (title, platform, owning_user, meeting_link, transcription_status)
         VALUES ($1, $2, $3, $4, 'pending')
         RETURNING meeting_id, title, platform, start_time, end_time,
                   transcript_location, owning_user, transcription_status,
                   meeting_link, created_at, updated_at`,
        [title, platform, owningUser, meetingLink],
    );

    const row = result.rows[0];
    const meeting = mapRowToMeetingMetadata(row);

    return meeting;
}

function formatPlatformName(platform: Platform): string {
    switch (platform) {
        case 'google_meet':
            return 'Google Meet';
        case 'zoom':
            return 'Zoom';
        case 'teams':
            return 'Teams';
    }
}

export function mapRowToMeetingMetadata(row: Record<string, any>): MeetingMetadata {
    return {
        meetingId: row.meeting_id,
        title: row.title,
        platform: row.platform,
        startTime: row.start_time?.toISOString?.() ?? row.start_time ?? undefined,
        endTime: row.end_time?.toISOString?.() ?? row.end_time ?? undefined,
        transcriptLocation: row.transcript_location ?? undefined,
        owningUser: row.owning_user,
        transcriptionStatus: row.transcription_status,
        meetingLink: row.meeting_link ?? undefined,
        createdAt: row.created_at?.toISOString?.() ?? row.created_at,
        updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
}


/**
 * Pure function: merge speaker label overrides into transcript entries.
 * For each entry, if a mapping exists for the entry's speaker (original_label → custom_label),
 * replace the speaker field. Otherwise leave unchanged.
 * Returns a new array — the input is never mutated.
 */
export function mergeSpeakerLabels(
    transcript: TranscriptEntry[],
    speakerLabels: { original_label: string; custom_label: string | null }[],
): TranscriptEntry[] {
    const labelMap = new Map<string, string>();
    for (const label of speakerLabels) {
        if (label.custom_label) {
            labelMap.set(label.original_label, label.custom_label);
        }
    }

    return transcript.map((entry) => {
        const customLabel = labelMap.get(entry.speaker);
        if (customLabel) {
            return { ...entry, speaker: customLabel };
        }
        return entry;
    });
}

/**
 * Upsert a speaker label mapping for a meeting.
 * Uses INSERT ... ON CONFLICT to create or update the custom_label.
 * Returns the upserted row.
 */
export async function upsertSpeakerLabel(
    meetingId: string,
    originalLabel: string,
    customLabel: string,
): Promise<{ id: string; meetingId: string; originalLabel: string; customLabel: string; updatedAt: string }> {
    const pool = getPool();
    const result = await pool.query(
        `INSERT INTO speaker_labels (meeting_id, original_label, custom_label)
         VALUES ($1, $2, $3)
         ON CONFLICT (meeting_id, original_label)
         DO UPDATE SET custom_label = $3, updated_at = NOW()
         RETURNING id, meeting_id, original_label, custom_label, updated_at`,
        [meetingId, originalLabel, customLabel],
    );
    const row = result.rows[0];
    return {
        id: row.id,
        meetingId: row.meeting_id,
        originalLabel: row.original_label,
        customLabel: row.custom_label,
        updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
}

/**
 * Fetch transcript for a meeting: load Transcript_JSON from Cloud Storage,
 * fetch speaker_labels from Cloud SQL, merge, and return.
 *
 * Returns { status, transcript? } — if transcription is not completed or
 * transcript_location is null, returns the current status without a transcript.
 */
export async function getTranscript(
    meetingId: string,
): Promise<{ status: string; transcript?: TranscriptEntry[] }> {
    const pool = getPool();

    // Fetch meeting metadata
    const meetingResult = await pool.query(
        `SELECT transcription_status, transcript_location FROM meetings WHERE meeting_id = $1`,
        [meetingId],
    );

    if (meetingResult.rows.length === 0) {
        throw new Error('Meeting not found');
    }

    const { transcription_status, transcript_location } = meetingResult.rows[0];

    // If not completed or no transcript location, return status only (Req 12.5)
    if (transcription_status !== 'completed' || !transcript_location) {
        return { status: transcription_status };
    }

    // Parse gs:// URI → bucket + path
    const gcsUri: string = transcript_location;
    const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!match) {
        throw new Error('Invalid transcript location format');
    }
    const [, bucketName, filePath] = match;

    // Fetch Transcript_JSON from Cloud Storage
    const storage = new Storage();
    const [fileContents] = await storage.bucket(bucketName).file(filePath).download();
    const transcript: TranscriptEntry[] = JSON.parse(fileContents.toString('utf-8'));

    // Fetch speaker labels from Cloud SQL
    const labelsResult = await pool.query(
        `SELECT original_label, custom_label FROM speaker_labels WHERE meeting_id = $1`,
        [meetingId],
    );

    // Merge and return
    const merged = mergeSpeakerLabels(transcript, labelsResult.rows);
    return { status: transcription_status, transcript: merged };
}
