import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authMiddleware } from './auth';
import { setPool } from '../db';

function createMockPool(queryFn: (...args: any[]) => any) {
    return { query: vi.fn(queryFn) } as any;
}

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

describe('authMiddleware', () => {
    it('should return 401 when no token is provided', async () => {
        const req = createMockReq();
        const res = createMockRes();
        const next = vi.fn();

        await authMiddleware(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(res.body.error).toBe('Authentication required');
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when session token is invalid', async () => {
        const mockPool = createMockPool(() => ({ rows: [] }));
        setPool(mockPool);

        const req = createMockReq({
            headers: { authorization: 'Bearer invalid-token' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await authMiddleware(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('should attach user and call next when session is valid (Bearer token)', async () => {
        const futureDate = new Date(Date.now() + 3600000);
        const mockPool = createMockPool(() => ({
            rows: [{ user_email: 'user@test.com', user_name: 'Test User', expires_at: futureDate }],
        }));
        setPool(mockPool);

        const req = createMockReq({
            headers: { authorization: 'Bearer valid-token' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await authMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.user).toEqual({ email: 'user@test.com', name: 'Test User' });
    });

    it('should extract token from session cookie', async () => {
        const futureDate = new Date(Date.now() + 3600000);
        const mockPool = createMockPool(() => ({
            rows: [{ user_email: 'cookie@test.com', user_name: 'Cookie User', expires_at: futureDate }],
        }));
        setPool(mockPool);

        const req = createMockReq({
            headers: { cookie: 'session=cookie-token; other=value' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await authMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.user).toEqual({ email: 'cookie@test.com', name: 'Cookie User' });
    });

    it('should return 401 when session is expired', async () => {
        const pastDate = new Date(Date.now() - 3600000);
        const mockPool = createMockPool(() => ({
            rows: [{ user_email: 'user@test.com', user_name: 'Test User', expires_at: pastDate }],
        }));
        setPool(mockPool);

        const req = createMockReq({
            headers: { authorization: 'Bearer expired-token' } as any,
        });
        const res = createMockRes();
        const next = vi.fn();

        await authMiddleware(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });
});
