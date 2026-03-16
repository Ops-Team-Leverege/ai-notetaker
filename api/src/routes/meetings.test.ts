import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { setPool } from '../db';

// Mock @google-cloud/storage before any imports that use it
vi.mock('@google-cloud/storage', () => {
    const downloadMock = vi.fn();
    const fileMock = vi.fn(() => ({ download: downloadMock }));
    const bucketMock = vi.fn(() => ({ file: fileMock }));
    const StorageMock = vi.fn(() => ({ bucket: bucketMock }));
    return {
        Storage: StorageMock,
        __downloadMock: downloadMock,
        __fileMock: fileMock,
        __bucketMock: bucketMock,
    };
});

// Mock auth middleware to inject user
vi.mock('../middleware/auth', () => ({
    authMiddleware: (req: any, res: any, next: any) => {
        if (req.headers['x-test-user']) {
            req.user = { email: req.headers['x-test-user'], name: 'Test User' };
            next();
        } else {
            res.status(401).json({ error: 'Authentication required' });
        }
    },
}));

// Mock rate limit middleware to pass through
vi.mock('../middleware/rateLimit', () => ({
    rateLimitMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import meetingsRoutes from './meetings';

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/meetings', meetingsRoutes);
    return app;
}

function createMockPool(queryFn: (...args: any[]) => any) {
    return { query: vi.fn(queryFn) } as any;
}

const sampleRow = {
    meeting_id: 'meeting-1',
    title: 'Google Meet meeting — 2026-01-01T00:00:00.000Z',
    platform: 'google_meet',
    start_time: null,
    end_time: null,
    transcript_location: null,
    owning_user: 'user@test.com',
    transcription_status: 'pending',
    meeting_link: 'https://meet.google.com/abc-defg-hij',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('GET /api/meetings', () => {
    it('returns 401 when not authenticated', async () => {
        const app = createApp();
        const res = await request(app).get('/api/meetings');
        expect(res.status).toBe(401);
    });

    it('returns meetings for the authenticated user', async () => {
        const mockPool = createMockPool((query: string, params: any[]) => {
            if (query.includes('WHERE owning_user')) {
                expect(params[0]).toBe('user@test.com');
                return { rows: [sampleRow] };
            }
            return { rows: [] };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].meetingId).toBe('meeting-1');
        expect(res.body[0].owningUser).toBe('user@test.com');
    });

    it('does not include meetingLink in response', async () => {
        const mockPool = createMockPool(() => ({ rows: [sampleRow] }));
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body[0]).not.toHaveProperty('meetingLink');
    });

    it('returns empty array when user has no meetings', async () => {
        const mockPool = createMockPool(() => ({ rows: [] }));
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

describe('GET /api/meetings/:id', () => {
    it('returns 401 when not authenticated', async () => {
        const app = createApp();
        const res = await request(app).get('/api/meetings/meeting-1');
        expect(res.status).toBe(401);
    });

    it('returns 404 when meeting does not exist', async () => {
        const mockPool = createMockPool(() => ({ rows: [] }));
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/nonexistent')
            .set('x-test-user', 'user@test.com');

        // ownershipMiddleware returns 404 for missing meetings
        expect(res.status).toBe(404);
    });

    it('returns 403 when user does not own the meeting', async () => {
        const mockPool = createMockPool(() => ({
            rows: [{ owning_user: 'other@test.com' }],
        }));
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(403);
    });

    it('returns meeting metadata when user owns the meeting', async () => {
        // ownershipMiddleware queries first, then the route handler queries
        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                // ownershipMiddleware check
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            // route handler getMeetingById
            return { rows: [sampleRow] };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body.meetingId).toBe('meeting-1');
        expect(res.body.platform).toBe('google_meet');
        expect(res.body.owningUser).toBe('user@test.com');
    });

    it('does not include meetingLink in detail response', async () => {
        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            return { rows: [sampleRow] };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty('meetingLink');
    });
});

describe('GET /api/meetings/:id/transcript', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns 401 when not authenticated', async () => {
        const app = createApp();
        const res = await request(app).get('/api/meetings/meeting-1/transcript');
        expect(res.status).toBe(401);
    });

    it('returns 403 when user does not own the meeting', async () => {
        const mockPool = createMockPool(() => ({
            rows: [{ owning_user: 'other@test.com' }],
        }));
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1/transcript')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(403);
    });

    it('returns status only when transcription is not completed', async () => {
        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                // ownershipMiddleware
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            // getTranscript — meeting query
            return {
                rows: [{ transcription_status: 'processing', transcript_location: null }],
            };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1/transcript')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('processing');
        expect(res.body).not.toHaveProperty('transcript');
    });

    it('returns status only when transcript_location is null', async () => {
        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            return {
                rows: [{ transcription_status: 'pending', transcript_location: null }],
            };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1/transcript')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
        expect(res.body).not.toHaveProperty('transcript');
    });

    it('returns merged transcript when transcription is completed', async () => {
        const rawTranscript = [
            { speaker: 'Speaker 1', text: "Let's begin.", timestamp: '2026-03-13T14:00:05Z' },
            { speaker: 'Speaker 2', text: 'Sounds good.', timestamp: '2026-03-13T14:00:12Z' },
        ];

        // Set up GCS mock to return transcript
        const { __downloadMock, __bucketMock, __fileMock } = await import('@google-cloud/storage') as any;
        __downloadMock.mockResolvedValue([Buffer.from(JSON.stringify(rawTranscript))]);

        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                // ownershipMiddleware
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            if (callCount === 2) {
                // getTranscript — meeting query
                return {
                    rows: [{
                        transcription_status: 'completed',
                        transcript_location: 'gs://leverege-notetaker-transcripts/abc123/meeting-1/transcript.json',
                    }],
                };
            }
            // getTranscript — speaker_labels query
            return {
                rows: [{ original_label: 'Speaker 1', custom_label: 'Alice' }],
            };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1/transcript')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('completed');
        expect(res.body.transcript).toHaveLength(2);
        // Speaker 1 should be merged to Alice
        expect(res.body.transcript[0].speaker).toBe('Alice');
        // Speaker 2 has no mapping, stays unchanged
        expect(res.body.transcript[1].speaker).toBe('Speaker 2');
        // Text and timestamps preserved
        expect(res.body.transcript[0].text).toBe("Let's begin.");
        expect(res.body.transcript[0].timestamp).toBe('2026-03-13T14:00:05Z');

        // Verify GCS was called with correct bucket and path
        expect(__bucketMock).toHaveBeenCalledWith('leverege-notetaker-transcripts');
        expect(__fileMock).toHaveBeenCalledWith('abc123/meeting-1/transcript.json');
    });

    it('returns transcript with no label changes when no speaker_labels exist', async () => {
        const rawTranscript = [
            { speaker: 'Speaker 1', text: 'Hello.', timestamp: '2026-03-13T14:00:05Z' },
        ];

        const { __downloadMock } = await import('@google-cloud/storage') as any;
        __downloadMock.mockResolvedValue([Buffer.from(JSON.stringify(rawTranscript))]);

        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            if (callCount === 2) {
                return {
                    rows: [{
                        transcription_status: 'completed',
                        transcript_location: 'gs://leverege-notetaker-transcripts/abc/m1/transcript.json',
                    }],
                };
            }
            // No speaker labels
            return { rows: [] };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1/transcript')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(200);
        expect(res.body.transcript[0].speaker).toBe('Speaker 1');
    });

    it('returns 404 when meeting does not exist in getTranscript', async () => {
        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                // ownershipMiddleware — meeting not found
                return { rows: [] };
            }
            return { rows: [] };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/nonexistent/transcript')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(404);
    });
});

describe('PATCH /api/meetings/:id/speakers', () => {
    it('returns 401 when not authenticated', async () => {
        const app = createApp();
        const res = await request(app)
            .patch('/api/meetings/meeting-1/speakers')
            .send({ originalLabel: 'Speaker 1', customLabel: 'Alice' });
        expect(res.status).toBe(401);
    });

    it('returns 403 when user does not own the meeting', async () => {
        const mockPool = createMockPool(() => ({
            rows: [{ owning_user: 'other@test.com' }],
        }));
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .patch('/api/meetings/meeting-1/speakers')
            .set('x-test-user', 'user@test.com')
            .send({ originalLabel: 'Speaker 1', customLabel: 'Alice' });

        expect(res.status).toBe(403);
    });

    it('returns 400 when originalLabel is missing', async () => {
        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            return { rows: [] };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .patch('/api/meetings/meeting-1/speakers')
            .set('x-test-user', 'user@test.com')
            .send({ customLabel: 'Alice' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('originalLabel');
    });

    it('returns 400 when customLabel is missing', async () => {
        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            return { rows: [] };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .patch('/api/meetings/meeting-1/speakers')
            .set('x-test-user', 'user@test.com')
            .send({ originalLabel: 'Speaker 1' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('customLabel');
    });

    it('returns 200 on successful upsert with correct SQL params', async () => {
        const upsertedRow = {
            id: 'label-1',
            meeting_id: 'meeting-1',
            original_label: 'Speaker 1',
            custom_label: 'Alice',
            updated_at: new Date('2026-01-01T00:00:00Z'),
        };

        let callCount = 0;
        const mockPool = createMockPool((query: string, params: any[]) => {
            callCount++;
            if (callCount === 1) {
                // ownershipMiddleware
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            // upsertSpeakerLabel — verify SQL and params
            expect(query).toContain('INSERT INTO speaker_labels');
            expect(query).toContain('ON CONFLICT');
            expect(params[0]).toBe('meeting-1');
            expect(params[1]).toBe('Speaker 1');
            expect(params[2]).toBe('Alice');
            return { rows: [upsertedRow] };
        });
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .patch('/api/meetings/meeting-1/speakers')
            .set('x-test-user', 'user@test.com')
            .send({ originalLabel: 'Speaker 1', customLabel: 'Alice' });

        expect(res.status).toBe(200);
        expect(res.body.meetingId).toBe('meeting-1');
        expect(res.body.originalLabel).toBe('Speaker 1');
        expect(res.body.customLabel).toBe('Alice');
        expect(res.body.id).toBe('label-1');
    });
});
