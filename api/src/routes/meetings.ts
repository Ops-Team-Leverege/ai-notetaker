import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { ownershipMiddleware } from '../middleware/ownership';
import { rateLimitMiddleware } from '../middleware/rateLimit';
import { createMeeting, listMeetings, getMeetingById, getTranscript, upsertSpeakerLabel } from '../services/meetings';

const router = Router();

/**
 * POST /api/meetings — Submit a meeting link for capture.
 * Requires auth + rate limit. Creates meeting record with status 'pending'.
 * TODO: Phase 2+ — after creating the record, dispatch bot for external meetings.
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
