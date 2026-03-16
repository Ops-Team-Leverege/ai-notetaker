import { describe, it, expect, vi, beforeEach } from 'vitest';
import { convertTranscript, hashUserEmail, handleMeetingCompleted, WorkspaceEvent, WorkspaceTranscriptEntry } from './workspace';
import { setPool } from '../db';

// Mock @google-cloud/storage
vi.mock('@google-cloud/storage', () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const fileFn = vi.fn(() => ({ save: saveFn }));
    const bucketFn = vi.fn(() => ({ file: fileFn }));
    return {
        Storage: vi.fn(() => ({ bucket: bucketFn })),
        __mockBucket: bucketFn,
        __mockFile: fileFn,
        __mockSave: saveFn,
    };
});

import { __mockBucket, __mockFile, __mockSave } from '@google-cloud/storage';

const mockBucket = __mockBucket as ReturnType<typeof vi.fn>;
const mockFile = __mockFile as ReturnType<typeof vi.fn>;
const mockSave = __mockSave as ReturnType<typeof vi.fn>;

function createMockPool(queryFn: (...args: any[]) => any) {
    return { query: vi.fn(queryFn) } as any;
}

describe('convertTranscript', () => {
    it('maps participantName to speaker, text to text, startTime to timestamp', () => {
        const input: WorkspaceTranscriptEntry[] = [
            { participantName: 'John', text: "Let's begin.", startTime: '2026-03-13T14:00:05Z' },
            { participantName: 'Jane', text: 'Sounds good.', startTime: '2026-03-13T14:00:12Z' },
        ];

        const result = convertTranscript(input);

        expect(result).toEqual([
            { speaker: 'John', text: "Let's begin.", timestamp: '2026-03-13T14:00:05Z' },
            { speaker: 'Jane', text: 'Sounds good.', timestamp: '2026-03-13T14:00:12Z' },
        ]);
    });

    it('returns empty array for empty input', () => {
        expect(convertTranscript([])).toEqual([]);
    });

    it('preserves all entries in order', () => {
        const input: WorkspaceTranscriptEntry[] = [
            { participantName: 'A', text: 'First', startTime: '2026-01-01T00:00:00Z' },
            { participantName: 'B', text: 'Second', startTime: '2026-01-01T00:00:01Z' },
            { participantName: 'A', text: 'Third', startTime: '2026-01-01T00:00:02Z' },
        ];

        const result = convertTranscript(input);
        expect(result).toHaveLength(3);
        expect(result[0].speaker).toBe('A');
        expect(result[1].speaker).toBe('B');
        expect(result[2].speaker).toBe('A');
    });
});

describe('hashUserEmail', () => {
    it('returns a SHA-256 hex string', () => {
        const hash = hashUserEmail('user@leverege.com');
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns consistent hash for same input', () => {
        const hash1 = hashUserEmail('user@leverege.com');
        const hash2 = hashUserEmail('user@leverege.com');
        expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different emails', () => {
        const hash1 = hashUserEmail('alice@leverege.com');
        const hash2 = hashUserEmail('bob@leverege.com');
        expect(hash1).not.toBe(hash2);
    });
});

describe('handleMeetingCompleted', () => {
    beforeEach(() => {
        mockSave.mockReset().mockResolvedValue(undefined);
        mockFile.mockReset().mockReturnValue({ save: mockSave });
        mockBucket.mockReset().mockReturnValue({ file: mockFile });
    });

    it('uploads transcript to GCS and creates meeting record', async () => {
        const event: WorkspaceEvent = {
            type: 'meeting.ended',
            meetingId: 'meet-123',
            organizer: 'user@leverege.com',
            title: 'Weekly Standup',
            startTime: '2026-03-13T14:00:00Z',
            endTime: '2026-03-13T14:30:00Z',
            transcript: [
                { participantName: 'John', text: "Let's begin.", startTime: '2026-03-13T14:00:05Z' },
            ],
        };

        const ownerHash = hashUserEmail('user@leverege.com');
        const mockRow = {
            meeting_id: 'meet-123',
            title: 'Weekly Standup',
            platform: 'google_meet',
            start_time: new Date('2026-03-13T14:00:00Z'),
            end_time: new Date('2026-03-13T14:30:00Z'),
            transcript_location: `gs://leverege-notetaker-transcripts/${ownerHash}/meet-123/transcript.json`,
            owning_user: 'user@leverege.com',
            transcription_status: 'completed',
            meeting_link: null,
            created_at: new Date(),
            updated_at: new Date(),
        };

        const mockPool = createMockPool(() => ({ rows: [mockRow] }));
        setPool(mockPool);

        const result = await handleMeetingCompleted(event);

        // Verify GCS upload
        expect(mockSave).toHaveBeenCalledWith(
            JSON.stringify([{ speaker: 'John', text: "Let's begin.", timestamp: '2026-03-13T14:00:05Z' }]),
            { contentType: 'application/json' },
        );

        // Verify Cloud SQL insert
        expect(mockPool.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO meetings'),
            expect.arrayContaining(['meet-123', 'Weekly Standup', '2026-03-13T14:00:00Z']),
        );

        expect(result.meetingId).toBe('meet-123');
        expect(result.transcriptionStatus).toBe('completed');
    });

    it('handles event with empty transcript array', async () => {
        const event: WorkspaceEvent = {
            type: 'meeting.ended',
            meetingId: 'meet-456',
            organizer: 'user@leverege.com',
            title: 'Empty Meeting',
            startTime: '2026-03-13T14:00:00Z',
            endTime: '2026-03-13T14:30:00Z',
            transcript: [],
        };

        const mockRow = {
            meeting_id: 'meet-456',
            title: 'Empty Meeting',
            platform: 'google_meet',
            start_time: new Date('2026-03-13T14:00:00Z'),
            end_time: new Date('2026-03-13T14:30:00Z'),
            transcript_location: 'gs://leverege-notetaker-transcripts/somehash/meet-456/transcript.json',
            owning_user: 'user@leverege.com',
            transcription_status: 'completed',
            meeting_link: null,
            created_at: new Date(),
            updated_at: new Date(),
        };

        const mockPool = createMockPool(() => ({ rows: [mockRow] }));
        setPool(mockPool);

        const result = await handleMeetingCompleted(event);

        // Should upload empty array
        expect(mockSave).toHaveBeenCalledWith('[]', { contentType: 'application/json' });
        expect(result.meetingId).toBe('meet-456');
    });

    it('throws when GCS upload fails', async () => {
        mockSave.mockRejectedValue(new Error('GCS upload failed'));

        const event: WorkspaceEvent = {
            type: 'meeting.ended',
            meetingId: 'meet-789',
            organizer: 'user@leverege.com',
            title: 'Failing Meeting',
            startTime: '2026-03-13T14:00:00Z',
            endTime: '2026-03-13T14:30:00Z',
            transcript: [
                { participantName: 'John', text: 'Hello', startTime: '2026-03-13T14:00:05Z' },
            ],
        };

        await expect(handleMeetingCompleted(event)).rejects.toThrow('GCS upload failed');
    });

    it('throws when Cloud SQL insert fails', async () => {
        const mockPool = createMockPool(() => {
            throw new Error('Cloud SQL insert failed');
        });
        setPool(mockPool);

        const event: WorkspaceEvent = {
            type: 'meeting.ended',
            meetingId: 'meet-fail',
            organizer: 'user@leverege.com',
            title: 'SQL Fail Meeting',
            startTime: '2026-03-13T14:00:00Z',
            endTime: '2026-03-13T14:30:00Z',
            transcript: [
                { participantName: 'John', text: 'Hello', startTime: '2026-03-13T14:00:05Z' },
            ],
        };

        await expect(handleMeetingCompleted(event)).rejects.toThrow('Cloud SQL insert failed');
    });
});
