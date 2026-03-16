import { Router, Request, Response } from 'express';
import { cleanupExpiredSessions } from '../services/auth';

const router = Router();

/**
 * POST /internal/cleanup-sessions — Called by Cloud Scheduler nightly.
 * Deletes all expired sessions from Cloud SQL.
 */
router.post('/cleanup-sessions', async (_req: Request, res: Response) => {
    try {
        const deletedCount = await cleanupExpiredSessions();
        res.status(200).json({ deleted: deletedCount });
    } catch (err) {
        res.status(500).json({ error: 'Session cleanup failed' });
    }
});

export default router;
