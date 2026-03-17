import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock auth service
vi.mock('../services/auth', () => ({
    handleCallback: vi.fn(),
    logout: vi.fn(),
    getClientCredentials: vi.fn().mockReturnValue({ clientId: 'test-id', clientSecret: 'test-secret' }),
    initiateLogin: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?test=1'),
}));

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

import authRoutes from './auth';
import { handleCallback } from '../services/auth';

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    return app;
}

describe('GET /api/auth/callback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 400 when code query param is missing', async () => {
        const app = createApp();
        const res = await request(app).get('/api/auth/callback');
        expect(res.status).toBe(400);
    });

    it('exchanges code and redirects to / on success', async () => {
        const mockSession = {
            token: 'session-token-123',
            user: { email: 'user@test.com', name: 'Test User' },
            expiresAt: new Date(Date.now() + 86400000),
        };
        (handleCallback as any).mockResolvedValue(mockSession);

        const app = createApp();
        const res = await request(app).get('/api/auth/callback?code=auth-code-123');

        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
        expect(res.headers['set-cookie']).toBeDefined();
        expect(handleCallback).toHaveBeenCalledWith('auth-code-123', expect.stringContaining('/api/auth/callback'));
    });

    it('returns 401 when handleCallback throws', async () => {
        (handleCallback as any).mockRejectedValue(new Error('Invalid code'));

        const app = createApp();
        const res = await request(app).get('/api/auth/callback?code=bad-code');

        expect(res.status).toBe(401);
    });
});

describe('POST /api/auth/callback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 400 when code is missing from body', async () => {
        const app = createApp();
        const res = await request(app).post('/api/auth/callback').send({});
        expect(res.status).toBe(400);
    });

    it('exchanges code and returns user on success', async () => {
        const mockSession = {
            token: 'session-token-456',
            user: { email: 'user@test.com', name: 'Test User' },
            expiresAt: new Date(Date.now() + 86400000),
        };
        (handleCallback as any).mockResolvedValue(mockSession);

        const app = createApp();
        const res = await request(app)
            .post('/api/auth/callback')
            .send({ code: 'auth-code-456' });

        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe('user@test.com');
        expect(handleCallback).toHaveBeenCalledWith('auth-code-456', expect.stringContaining('/api/auth/callback'));
    });
});

describe('GET /api/auth/login', () => {
    it('redirects to Google OAuth URL', async () => {
        const app = createApp();
        const res = await request(app).get('/api/auth/login');
        expect(res.status).toBe(302);
        expect(res.headers.location).toContain('accounts.google.com');
    });
});
