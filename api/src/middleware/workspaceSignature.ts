import { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';

const oauthClient = new OAuth2Client();

/**
 * Verify Google-signed Bearer token on POST /api/workspace/events.
 * Google Workspace Events API sends push notifications with a signed
 * ID token in the Authorization header. We verify it against the
 * expected audience (our Cloud Run service URL).
 *
 * Returns 403 if verification fails.
 */
export async function workspaceSignatureMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(403).json({ error: 'Missing or invalid authorization header' });
        return;
    }

    const token = authHeader.slice(7);

    if (!token) {
        res.status(403).json({ error: 'Missing or invalid authorization header' });
        return;
    }

    const audience = process.env.WORKSPACE_EVENTS_AUDIENCE;
    if (!audience) {
        // If audience is not configured, we cannot verify — reject for safety
        res.status(403).json({ error: 'Workspace events audience not configured' });
        return;
    }

    try {
        await oauthClient.verifyIdToken({
            idToken: token,
            audience,
        });
        next();
    } catch {
        res.status(403).json({ error: 'Invalid signature' });
    }
}
