import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response } from 'express';

// Mock google-auth-library before importing the middleware
vi.mock('google-auth-library', () => {
    const verifyIdToken = vi.fn();
    return {
        OAuth2Client: vi.fn(() => ({ verifyIdToken })),
        __mockVerifyIdToken: verifyIdToken,
    };
});

import { workspaceSignatureMiddleware } from './workspaceSignature';
import { __mockVerifyIdToken } from 'google-auth-library';

const mockVerifyIdToken = __mockVerifyIdToken as ReturnType<typeof vi.fn>;

function createMockReq(overrides: Partial<Request> = {}): Request {
    return {
        headers: {},
        ...overrides,
    } as Request;
}

function createMockRes(): Response & { statusCode: number; body: any } {
    const res: any = {
        statusCode: 0,
        body: null,
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(data: any) {
            res.body = data;
            return res;
        },
    };
    return res;
}

describe('workspaceSignatureMiddleware', () => {
    const originalEnv = process.env.WORKSPACE_EVENTS_AUDIENCE;

    beforeEach(() => {
        process.env.WORKSPACE_EVENTS_AUDIENCE = 'https://api.example.com';
        mockVerifyIdToken.mockReset();
    });

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.WORKSPACE_EVENTS_AUDIENCE = originalEnv;
        } else {
            delete process.env.WORKSPACE_EVENTS_AUDIENCE;
        }
    });

    it('should return 403 when no Authorization header is present', async () => {
        const req = createMockReq();
        const res = createMockRes();
        const next = vi.fn();

        await workspaceSignatureMiddleware(req, res, next);

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('Missing or invalid authorization header');
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when Authorization header is not Bearer', async () => {
        const req = createMockReq({
            headers: { authorization: 'Basic abc123' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await workspaceSignatureMiddleware(req, res, next);

        expect(res.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when Bearer token is empty', async () => {
        const req = createMockReq({
            headers: { authorization: 'Bearer ' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await workspaceSignatureMiddleware(req, res, next);

        expect(res.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when WORKSPACE_EVENTS_AUDIENCE is not configured', async () => {
        delete process.env.WORKSPACE_EVENTS_AUDIENCE;

        const req = createMockReq({
            headers: { authorization: 'Bearer valid-token' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await workspaceSignatureMiddleware(req, res, next);

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('Workspace events audience not configured');
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when token verification fails', async () => {
        mockVerifyIdToken.mockRejectedValue(new Error('Invalid token'));

        const req = createMockReq({
            headers: { authorization: 'Bearer bad-token' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await workspaceSignatureMiddleware(req, res, next);

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('Invalid signature');
        expect(next).not.toHaveBeenCalled();
    });

    it('should call next when token verification succeeds', async () => {
        mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({}) });

        const req = createMockReq({
            headers: { authorization: 'Bearer valid-google-token' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await workspaceSignatureMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(mockVerifyIdToken).toHaveBeenCalledWith({
            idToken: 'valid-google-token',
            audience: 'https://api.example.com',
        });
    });
});
