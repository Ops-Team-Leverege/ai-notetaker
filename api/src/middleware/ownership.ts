import { Request, Response, NextFunction } from 'express';
import { getPool } from '../db';

/**
 * Verify that the authenticated user owns the requested meeting.
 * Expects req.user to be set by authMiddleware.
 * Expects req.params.id to contain the meeting ID.
 * Returns 403 if the user does not own the meeting, 404 if meeting not found.
 */
export async function ownershipMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const meetingId = req.params.id;
    const user = req.user;

    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    if (!meetingId) {
        res.status(400).json({ error: 'Meeting ID required' });
        return;
    }

    try {
        const pool = getPool();
        const result = await pool.query(
            'SELECT owning_user FROM meetings WHERE meeting_id = $1',
            [meetingId]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Meeting not found' });
            return;
        }

        if (result.rows[0].owning_user !== user.email) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }

        next();
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
}
