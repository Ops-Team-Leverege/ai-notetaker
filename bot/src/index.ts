/**
 * Bot Orchestrator Cloud Run service entry point.
 */

import express from 'express';
import { dispatchBot, getBotStatus, stopBot, streamStatus } from './orchestrator';
import { Platform } from './types';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

/**
 * POST /dispatch - Dispatch a bot to join a meeting.
 */
app.post('/dispatch', async (req, res) => {
    const { meetingId, meetingUrl, platform, owningUser } = req.body;

    if (!meetingId || !meetingUrl || !platform || !owningUser) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const session = await dispatchBot({
            meetingId,
            meetingUrl,
            platform: platform as Platform,
            owningUser,
        });

        res.json({ status: 'dispatched', session });
    } catch (err) {
        console.error('Failed to dispatch bot:', err);
        res.status(500).json({ error: 'Failed to dispatch bot' });
    }
});

/**
 * GET /status/:meetingId - Get current bot status.
 */
app.get('/status/:meetingId', (req, res) => {
    const { meetingId } = req.params;
    const session = getBotStatus(meetingId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ session });
});

/**
 * GET /status/:meetingId/stream - SSE stream for bot status updates.
 */
app.get('/status/:meetingId/stream', (req, res) => {
    const { meetingId } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send current status
    const session = getBotStatus(meetingId);
    if (session) {
        res.write(`data: ${JSON.stringify({ status: session.status })}\n\n`);
    }

    // Subscribe to updates
    const unsubscribe = streamStatus(meetingId, (status) => {
        res.write(`data: ${JSON.stringify({ status })}\n\n`);
    });

    // Cleanup on close
    req.on('close', () => {
        unsubscribe();
    });
});

/**
 * POST /stop/:meetingId - Stop a bot.
 */
app.post('/stop/:meetingId', async (req, res) => {
    const { meetingId } = req.params;

    try {
        await stopBot(meetingId);
        res.json({ status: 'stopped' });
    } catch (err) {
        console.error('Failed to stop bot:', err);
        res.status(500).json({ error: 'Failed to stop bot' });
    }
});

/**
 * Health check.
 */
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

app.listen(PORT, () => {
    console.log(`Bot Orchestrator listening on port ${PORT}`);
});
