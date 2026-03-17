import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ownershipMiddleware } from '../middleware/ownership';
import { rateLimitMiddleware } from '../middleware/rateLimit';
import { createMeeting, listMeetings, getMeetingById, getTranscript, upsertSpeakerLabel } from '../services/meetings';
import { dispatchBot } from '../services/botDispatch';
import { getPool } from '../db';

const router = Router();

/**
 * POST /api/meetings — Submit a meeting link for capture.
 * Requires auth + rate limit. Creates meeting record with status 'pending',
 * then dispatches the appropriate bot based on platform.
 */
router.post(
    '/',
    authMiddleware,
    rateLimitMiddleware,
    async (req: Request, res: Response) => {
        const { meetingLink } = req.body;

        if (!meetingLink || typeof meetingLink !== 'string') {
            res.status(400).json({ error: 'meetingLink is required and must be a string' });
            return;
        }

        try {
            const meeting = await createMeeting(meetingLink, req.user!.email);

            // Dispatch bot asynchronously — don't block the response
            dispatchBot(meeting.meetingId, meetingLink, meeting.platform, req.user!.email).catch(
                (err) => console.error(`[meetings] Bot dispatch failed for ${meeting.meetingId}:`, err),
            );

            // Strip meeting_link from response — it's sensitive
            const { meetingLink: _link, ...safeMetadata } = meeting;
            res.status(201).json(safeMetadata);
        } catch (err: any) {
            if (
                err.message === 'Invalid URL' ||
                err.message === 'Unsupported meeting platform'
            ) {
                res.status(400).json({ error: err.message });
                return;
            }
            res.status(500).json({ error: 'Failed to create meeting' });
        }
    },
);

/**
 * GET /api/meetings — List meetings for the authenticated user.
 * Filters by owning_user = req.user.email (per-user data scoping).
 * Ordered by created_at DESC.
 */
router.get(
    '/',
    authMiddleware,
    async (req: Request, res: Response) => {
        try {
            const meetings = await listMeetings(req.user!.email);

            // Strip meeting_link from each meeting — it's sensitive
            const safeMeetings = meetings.map(({ meetingLink: _link, ...rest }) => rest);
            res.status(200).json(safeMeetings);
        } catch (err) {
            res.status(500).json({ error: 'Failed to list meetings' });
        }
    },
);

/**
 * GET /api/meetings/:id — Get single meeting metadata.
 * Requires auth + ownership check.
 * Strips meeting_link from response (sensitive).
 */
router.get(
    '/:id',
    authMiddleware,
    ownershipMiddleware,
    async (req: Request, res: Response) => {
        try {
            const meeting = await getMeetingById(req.params.id);

            if (!meeting) {
                res.status(404).json({ error: 'Meeting not found' });
                return;
            }

            // Strip meeting_link from response — it's sensitive
            const { meetingLink: _link, ...safeMetadata } = meeting;
            res.status(200).json(safeMetadata);
        } catch (err) {
            res.status(500).json({ error: 'Failed to get meeting' });
        }
    },
);

/**
 * GET /api/meetings/:id/transcript — Get transcript with merged speaker labels.
 * Requires auth + ownership check.
 * Fetches Transcript_JSON from Cloud Storage, merges speaker label overrides from Cloud SQL.
 * If transcription is not completed, returns current status instead.
 */
router.get(
    '/:id/transcript',
    authMiddleware,
    ownershipMiddleware,
    async (req: Request, res: Response) => {
        try {
            const result = await getTranscript(req.params.id);

            if (!result.transcript) {
                res.status(200).json({ status: result.status });
                return;
            }

            res.status(200).json({ status: result.status, transcript: result.transcript });
        } catch (err: any) {
            if (err.message === 'Meeting not found') {
                res.status(404).json({ error: 'Meeting not found' });
                return;
            }
            res.status(500).json({ error: 'Failed to retrieve transcript' });
        }
    },
);

/**
 * GET /api/meetings/:id/status — Server-Sent Events stream for meeting status.
 * Polls Cloud SQL every 3 seconds and pushes status updates to the client.
 * Closes the connection when status reaches a terminal state (completed/failed).
 */
router.get(
    '/:id/status',
    authMiddleware,
    ownershipMiddleware,
    async (req: Request, res: Response) => {
        const meetingId = req.params.id;

        // Set SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no', // Disable nginx buffering
        });

        const terminalStatuses = ['completed', 'failed', 'transcription_failed'];
        let closed = false;

        async function sendStatus() {
            if (closed) return;

            try {
                const pool = getPool();
                const result = await pool.query(
                    'SELECT transcription_status, updated_at FROM meetings WHERE meeting_id = $1',
                    [meetingId],
                );

                if (result.rows.length === 0) {
                    res.write(`data: ${JSON.stringify({ error: 'Meeting not found' })}\n\n`);
                    cleanup();
                    return;
                }

                const { transcription_status, updated_at } = result.rows[0];
                const payload = {
                    status: transcription_status,
                    updatedAt: updated_at?.toISOString?.() ?? updated_at,
                };

                res.write(`data: ${JSON.stringify(payload)}\n\n`);

                if (terminalStatuses.includes(transcription_status)) {
                    cleanup();
                }
            } catch (err) {
                if (!closed) {
                    res.write(`data: ${JSON.stringify({ error: 'Failed to fetch status' })}\n\n`);
                }
            }
        }

        function cleanup() {
            closed = true;
            clearInterval(intervalId);
            res.end();
        }

        // Send initial status immediately
        await sendStatus();

        // Poll every 3 seconds
        const intervalId = setInterval(sendStatus, 3000);

        // Clean up when client disconnects
        req.on('close', () => {
            cleanup();
        });
    },
);

/**
 * PATCH /api/meetings/:id/speakers — Upsert a speaker label mapping.
 * Requires auth + ownership check.
 * Body: { originalLabel: string, customLabel: string }
 */
router.patch(
    '/:id/speakers',
    authMiddleware,
    ownershipMiddleware,
    async (req: Request, res: Response) => {
        const { originalLabel, customLabel } = req.body;

        if (!originalLabel || typeof originalLabel !== 'string') {
            res.status(400).json({ error: 'originalLabel is required and must be a non-empty string' });
            return;
        }

        if (!customLabel || typeof customLabel !== 'string') {
            res.status(400).json({ error: 'customLabel is required and must be a non-empty string' });
            return;
        }

        try {
            const label = await upsertSpeakerLabel(req.params.id, originalLabel, customLabel);
            res.status(200).json(label);
        } catch (err) {
            res.status(500).json({ error: 'Failed to update speaker label' });
        }
    },
);

export default router;
