import { Router, Request, Response } from 'express';
import { handleCallback, logout, getClientCredentials, initiateLogin } from '../services/auth';
import { authMiddleware } from '../middleware/auth';

const router = Router();

/**
 * GET /api/auth/login — Redirect to Google SSO login flow.
 */
router.get('/login', async (req: Request, res: Response) => {
    try {
        const creds = await getClientCredentials();
        const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/callback`;
        const url = initiateLogin(redirectUri, creds.clientId);
        res.redirect(url);
    } catch (err) {
        res.status(500).json({ error: 'Failed to initiate login' });
    }
});

/**
 * POST /api/auth/callback — Google SSO OAuth callback (public).
 * Exchanges authorization code for tokens, creates session.
 */
router.post('/callback', async (req: Request, res: Response) => {
    const { code } = req.body;

    if (!code || typeof code !== 'string') {
        res.status(400).json({ error: 'Authorization code required' });
        return;
    }

    try {
        const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/callback`;
        const session = await handleCallback(code, redirectUri);

        res.cookie('session', session.token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            expires: session.expiresAt,
        });

        res.status(200).json({
            user: session.user,
            expiresAt: session.expiresAt.toISOString(),
        });
    } catch (err) {
        res.status(401).json({ error: 'Authentication failed' });
    }
});

/**
 * POST /api/auth/logout — Invalidate session (requires auth).
 */
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
    try {
        const token = extractToken(req);
        if (token) {
            await logout(token);
        }

        res.clearCookie('session');
        res.status(200).json({ message: 'Logged out' });
    } catch (err) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

/**
 * GET /api/auth/me — Return current user info (requires auth).
 */
router.get('/me', authMiddleware, (req: Request, res: Response) => {
    res.status(200).json({ user: req.user });
});

function extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        const match = cookieHeader.split(';').find((c) => c.trim().startsWith('session='));
        if (match) {
            return match.split('=')[1]?.trim() || null;
        }
    }
    return null;
}

export default router;
