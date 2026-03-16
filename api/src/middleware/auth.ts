import { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth';
import { getPool } from '../db';
import { User } from '../types';

// Extend Express Request to include user
declare global {
    namespace Express {
        interface Request {
            user?: User;
        }
    }
}

/**
 * Extract session token from cookie or Authorization header,
 * validate session, attach user to request context.
 * Returns 401 if invalid or expired.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = extractToken(req);

    if (!token) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    try {
        const user = await validateSession(token);
        if (!user) {
            res.status(401).json({ error: 'Invalid or expired session' });
            return;
        }

        req.user = user;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Authentication failed' });
    }
}

function extractToken(req: Request): string | null {
    // Check Authorization header first: "Bearer <token>"
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    // Check cookie
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        const match = cookieHeader.split(';').find((c) => c.trim().startsWith('session='));
        if (match) {
            return match.split('=')[1]?.trim() || null;
        }
    }

    return null;
}
