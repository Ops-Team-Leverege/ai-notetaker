import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import express from 'express';
import { setPool } from '../db';

// Mock auth middleware
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

vi.mock('../middleware/rateLimit', () => ({
    rateLimitMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@google-cloud/storage', () => ({
    Storage: vi.fn(() => ({ bucket: vi.fn(() => ({ file: vi.fn(() => ({ download: vi.fn() })) })) })),
}));

vi.mock('../services/botDispatch', () => ({
    dispatchBot: vi.fn().mockResolvedValue({ dispatched: true }),
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

describe('GET /api/meetings/:id/status (SSE)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns 401 when not authenticated', async () => {
        const app = createApp();
        const res = await request(app).get('/api/meetings/meeting-1/status');
        expect(res.status).toBe(401);
    });

    it('returns 403 when user does not own the meeting', async () => {
        const mockPool = createMockPool(() => ({
            rows: [{ owning_user: 'other@test.com' }],
        }));
        setPool(mockPool);

        const app = createApp();
        const res = await request(app)
            .get('/api/meetings/meeting-1/status')
            .set('x-test-user', 'user@test.com');

        expect(res.status).toBe(403);
    });

    it('sends SSE event with current status for terminal status', async () => {
        let callCount = 0;
        const mockPool = createMockPool(() => {
            callCount++;
            if (callCount === 1) {
                return { rows: [{ owning_user: 'user@test.com' }] };
            }
            return {
                rows: [{
                    transcription_status: 'completed',
                    updated_at: new Date('2026-03-17T10:00:00Z'),
                }],
            };
        });
        setPool(mockPool);

        const app = createApp();
        const server = http.createServer(app);

        const body = await new Promise<string>((resolve, reject) => {
            server.listen(0, () => {
                const port = (server.address() as any).port;
                let data = '';
                const req = http.get(
                    `http://127.0.0.1:${port}/api/meetings/meeting-1/status`,
                    { headers: { 'x-test-user': 'user@test.com' } },
                    (res) => {
                        res.on('data', (chunk) => {
                            data += chunk.toString();
                            // Once we have data containing our status, abort and resolve
                            if (data.includes('"completed"')) {
                                req.destroy();
                                server.close();
                                resolve(data);
                            }
                        });
                        res.on('error', () => { }); // Ignore abort errors
                    },
                );
                req.on('error', () => { }); // Ignore abort errors
                setTimeout(() => { req.destroy(); server.close(); reject(new Error('Timeout')); }, 4000);
            });
        });

        expect(body).toContain('data:');
        expect(body).toContain('"status":"completed"');
    });

    it('sends error event when meeting not found during poll', async () => {
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
        const server = http.createServer(app);

        const body = await new Promise<string>((resolve, reject) => {
            server.listen(0, () => {
                const port = (server.address() as any).port;
                let data = '';
                const req = http.get(
                    `http://127.0.0.1:${port}/api/meetings/meeting-1/status`,
                    { headers: { 'x-test-user': 'user@test.com' } },
                    (res) => {
                        res.on('data', (chunk) => {
                            data += chunk.toString();
                            if (data.includes('Meeting not found')) {
                                req.destroy();
                                server.close();
                                resolve(data);
                            }
                        });
                        res.on('error', () => { });
                    },
                );
                req.on('error', () => { });
                setTimeout(() => { req.destroy(); server.close(); reject(new Error('Timeout')); }, 4000);
            });
        });

        expect(body).toContain('Meeting not found');
    });
});
