import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Set env var before module import (read at load time)
vi.stubEnv('ZOOM_VERIFICATION_TOKEN', 'test-secret-token');

// Mock dependencies before importing the router
vi.mock('../db', () => ({
    getPool: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ rows: [{ meeting_id: 'test-id' }] }),
    }),
}));

vi.mock('../services/zoom', () => ({
    downloadAndUploadZoomRecording: vi.fn().mockResolvedValue('gs://leverege-notetaker-audio/hash/m1/audio.mp4'),
}));

vi.mock('../services/teams', () => ({
    downloadAndUploadTeamsRecording: vi.fn().mockResolvedValue('gs://leverege-notetaker-audio/hash/m2/audio.mp4'),
}));

vi.mock('@google-cloud/tasks', () => ({
    CloudTasksClient: vi.fn().mockImplementation(() => ({
        queuePath: vi.fn().mockReturnValue('projects/p/locations/l/queues/q'),
        createTask: vi.fn().mockResolvedValue([{}]),
    })),
}));

vi.mock('uuid', () => ({
    v4: vi.fn().mockReturnValue('generated-uuid'),
}));

import webhookRoutes from './webhooks';
import { downloadAndUploadZoomRecording } from '../services/zoom';
import { downloadAndUploadTeamsRecording } from '../services/teams';

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/webhooks', webhookRoutes);
    return app;
}

describe('Webhook Routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ─── Zoom ────────────────────────────────────────────────

    describe('POST /api/webhooks/zoom', () => {
        it('should handle Zoom URL validation challenge', async () => {
            const app = createApp();
            const res = await request(app)
                .post('/api/webhooks/zoom')
                .send({
                    event: 'endpoint.url_validation',
                    payload: { plainToken: 'abc123' },
                });

            expect(res.status).toBe(200);
            expect(res.body.plainToken).toBe('abc123');
            expect(res.body.encryptedToken).toBeDefined();
        });

        it('should ignore unsupported Zoom events', async () => {
            const app = createApp();
            const res = await request(app)
                .post('/api/webhooks/zoom')
                .send({ event: 'meeting.started', payload: {} });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ignored');
        });

        it('should process recording.completed event', async () => {
            const app = createApp();
            const res = await request(app)
                .post('/api/webhooks/zoom')
                .send({
                    event: 'recording.completed',
                    payload: {
                        object: {
                            id: 'zoom-meeting-123',
                            host_email: 'host@example.com',
                            topic: 'Weekly Standup',
                            start_time: '2026-03-16T10:00:00Z',
                            recording_files: [
                                {
                                    recording_type: 'audio_only',
                                    file_type: 'M4A',
                                    download_url: 'https://zoom.us/rec/download/abc',
                                },
                            ],
                        },
                    },
                });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('processed');
            expect(downloadAndUploadZoomRecording).toHaveBeenCalledWith(
                'https://zoom.us/rec/download/abc',
                'generated-uuid',
                'host@example.com',
            );
        });

        it('should return error when no recording files', async () => {
            const app = createApp();
            const res = await request(app)
                .post('/api/webhooks/zoom')
                .send({
                    event: 'recording.completed',
                    payload: {
                        object: {
                            id: 'zoom-meeting-456',
                            host_email: 'host@example.com',
                            topic: 'No Recording',
                            recording_files: [],
                        },
                    },
                });

            expect(res.status).toBe(200);
            expect(res.body.reason).toBe('No recording file');
        });

        it('should return 400 when payload.object is missing', async () => {
            const app = createApp();
            const res = await request(app)
                .post('/api/webhooks/zoom')
                .send({ event: 'recording.completed', payload: {} });

            expect(res.status).toBe(400);
        });
    });

    // ─── Teams ───────────────────────────────────────────────

    describe('POST /api/webhooks/teams', () => {
        it('should echo validationToken for Graph subscription validation', async () => {
            const app = createApp();
            const res = await request(app)
                .post('/api/webhooks/teams?validationToken=my-validation-token')
                .send({});

            expect(res.status).toBe(200);
            expect(res.text).toBe('my-validation-token');
        });

        it('should return 200 when no notifications in body', async () => {
            const app = createApp();
            const res = await request(app)
                .post('/api/webhooks/teams')
                .send({ value: [] });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ignored');
        });

        it('should accept and process change notifications', async () => {
            const app = createApp();
            const res = await request(app)
                .post('/api/webhooks/teams')
                .send({
                    value: [
                        {
                            resource: 'communications/callRecords/rec-001',
                            resourceData: {
                                organizerEmail: 'organizer@example.com',
                                subject: 'Sprint Review',
                                startDateTime: '2026-03-16T14:00:00Z',
                                endDateTime: '2026-03-16T15:00:00Z',
                            },
                        },
                    ],
                });

            // Graph expects 202 Accepted
            expect(res.status).toBe(202);
            expect(res.body.status).toBe('accepted');

            // Give async processing a moment
            await new Promise((r) => setTimeout(r, 100));

            expect(downloadAndUploadTeamsRecording).toHaveBeenCalledWith(
                'https://graph.microsoft.com/v1.0/communications/callRecords/rec-001/$value',
                'generated-uuid',
                'organizer@example.com',
            );
        });
    });
});
