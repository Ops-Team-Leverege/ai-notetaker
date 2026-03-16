import { Router, Request, Response } from 'express';
import { workspaceSignatureMiddleware } from '../middleware/workspaceSignature';
import { handleMeetingCompleted, WorkspaceEvent } from '../services/workspace';

const router = Router();

/**
 * POST /api/workspace/events — Receive signed Google Workspace push notifications.
 * Verifies signature via middleware, then processes the event.
 *
 * Error handling (Task 5.5):
 * - Missing/empty transcript: log error, return 200 (acknowledge to prevent retries)
 * - GCS upload failure: log error, return 500
 * - Cloud SQL insert failure: log error, return 500
 * - Never log meeting links or transcript content in error messages
 */
router.post(
    '/events',
    workspaceSignatureMiddleware,
    async (req: Request, res: Response) => {
        const event: WorkspaceEvent = req.body;

        // Validate event type
        if (event.type !== 'meeting.ended') {
            res.status(200).json({ status: 'ignored', reason: 'unsupported event type' });
            return;
        }

        // Validate required fields
        if (!event.meetingId || !event.organizer) {
            res.status(400).json({ error: 'Missing required event fields' });
            return;
        }

        // Check for missing/empty transcript — log error but acknowledge receipt (200)
        if (!event.transcript || event.transcript.length === 0) {
            console.error(
                `[workspace-events] Transcript unavailable for meeting ${event.meetingId}. ` +
                `Organizer: ${event.organizer}`,
            );
            // Return 200 to acknowledge receipt and prevent retries
            res.status(200).json({
                status: 'error',
                reason: 'Transcript unavailable for this meeting',
            });
            return;
        }

        try {
            const meeting = await handleMeetingCompleted(event);
            res.status(200).json({ status: 'processed', meetingId: meeting.meetingId });
        } catch (err: any) {
            // Log error without exposing transcript content or meeting links
            console.error(
                `[workspace-events] Failed to process meeting ${event.meetingId}: ${err.message}`,
            );
            res.status(500).json({ error: 'Failed to process workspace event' });
        }
    },
);

export default router;
