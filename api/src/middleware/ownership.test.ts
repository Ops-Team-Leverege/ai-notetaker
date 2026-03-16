import { describe, it, expect, vi } from 'vitest';
import { Request, Response } from 'express';
import { ownershipMiddleware } from './ownership';
import { setPool } from '../db';

function createMockPool(queryFn: (...args: any[]) => any) {
    return { query: vi.fn(queryFn) } as any;
}

function createMockReq(overrides: Partial<Request> = {}): Request {
    return {
        headers: {},
        params: {},
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

describe('ownershipMiddleware', () => {
    it('should return 401 when no user is attached', async () => {
        const req = createMockReq({ params: { id: 'meeting-1' } as any });
        const res = createMockRes();
        const next = vi.fn();

        await ownershipMiddleware(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 404 when meeting does not exist', async () => {
        const mockPool = createMockPool(() => ({ rows: [] }));
        setPool(mockPool);

        const req = createMockReq({
            params: { id: 'nonexistent' } as any,
            user: { email: 'user@test.com', name: 'Test' },
        } as any);
        const res = createMockRes();
        const next = vi.fn();

        await ownershipMiddleware(req, res, next);

        expect(res.statusCode).toBe(404);
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 when user does not own the meeting', async () => {
        const mockPool = createMockPool(() => ({
            rows: [{ owning_user: 'other@test.com' }],
        }));
        setPool(mockPool);

        const req = createMockReq({
            params: { id: 'meeting-1' } as any,
            user: { email: 'user@test.com', name: 'Test' },
        } as any);
        const res = createMockRes();
        const next = vi.fn();

        await ownershipMiddleware(req, res, next);

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('Access denied');
        expect(next).not.toHaveBeenCalled();
    });

    it('should call next when user owns the meeting', async () => {
        const mockPool = createMockPool(() => ({
            rows: [{ owning_user: 'user@test.com' }],
        }));
        setPool(mockPool);

        const req = createMockReq({
            params: { id: 'meeting-1' } as any,
            user: { email: 'user@test.com', name: 'Test' },
        } as any);
        const res = createMockRes();
        const next = vi.fn();

        await ownershipMiddleware(req, res, next);

        expect(next).toHaveBeenCalled();
    });
});
