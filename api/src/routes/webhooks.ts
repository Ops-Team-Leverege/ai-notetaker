/**
 * Webhook routes for Zoom and Teams cloud recording notifications.
 *
 * POST /api/webhooks/zoom   — Zoom recording.completed webhook
 * POST /api/webhooks/teams  — Microsoft Graph change notification (recording available)
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CloudTasksClient } from '@google-cloud/tasks';
import { getPool } from '../db';
import { hashUserEmail } from '../services/workspace';
import { downloadAndUploadZoomRecording } from '../services/zoom';
import { downloadAndUploadTeamsRecording } from '../services/teams';
import type { TranscriptionTask } from '../types';

const router = Router();

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'ai-meeting-notetaker-490206';
const REGION = process.env.GCP_REGION || 'us-central1';
const QUEUE_NAME = process.env.TRANSCRIPTION_QUEUE || 'transcription-queue';
const WORKER_URL = process.env.TRANSCRIPTION_WORKER_URL || '';

function getZoomVerificationToken(): string {
    return process.env.ZOOM_VERIFICATION_TOKEN || '';
}

// ─── Zoom Webhook ────────────────────────────────────────────

/**
 * POST /api/webhooks/zoom
 *
 * Handles two Zoom event types:
 *   1. endpoint.url_validation — Zoom CRC challenge/response for webhook verification
 *   2. recording.completed — Cloud recording is ready for download
 */
router.post('/zoom', async (req: Request, res: Response) => {
    // Log every incoming request for debugging
    console.log('[zoom-webhook] Incoming request:', {
        event: req.body?.event,
        hasPayload: !!req.body?.payload,
        headers: {
            'content-type': req.headers['content-type'],
            'x-zm-signature': req.headers['x-zm-signature'] ? '(present)' : '(missing)',
            'x-zm-request-timestamp': req.headers['x-zm-request-timestamp'] || '(missing)',
        },
    });

    const { event, payload } = req.body;

    // --- Zoom URL validation challenge (CRC) ---
    if (event === 'endpoint.url_validation') {
        const plainToken = payload?.plainToken;
        if (!plainToken) {
            console.error('[zoom-webhook] URL validation missing plainToken');
            res.status(400).json({ error: 'Missing plainToken' });
            return;
        }

        if (!getZoomVerificationToken()) {
            console.error('[zoom-webhook] ZOOM_VERIFICATION_TOKEN env var is not set — cannot compute CRC');
            res.status(500).json({ error: 'Server misconfiguration: missing verification token' });
            return;
        }

        const crypto = await import('crypto');
        const hashForValidate = crypto
            .createHmac('sha256', getZoomVerificationToken())
            .update(plainToken)
            .digest('hex');

        console.log('[zoom-webhook] URL validation response:', { plainToken, encryptedToken: hashForValidate });
        res.status(200).json({ plainToken, encryptedToken: hashForValidate });
        return;
    }

    // --- Verify Zoom webhook signature ---
    const signature = req.headers['x-zm-signature'] as string | undefined;
    const timestamp = req.headers['x-zm-request-timestamp'] as string | undefined;

    if (getZoomVerificationToken() && signature && timestamp) {
        const crypto = await import('crypto');
        const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;
        const expectedSig = `v0=${crypto.createHmac('sha256', getZoomVerificationToken()).update(message).digest('hex')}`;
        if (signature !== expectedSig) {
            console.error('[zoom-webhook] Invalid signature');
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }
    }

    // --- Handle recording.completed ---
    if (event !== 'recording.completed') {
        res.status(200).json({ status: 'ignored', reason: `unsupported event: ${event}` });
        return;
    }

    try {
        const object = payload?.object;
        if (!object) {
            res.status(400).json({ error: 'Missing payload.object' });
            return;
        }

        const hostEmail: string = object.host_email;
        const topic: string = object.topic || 'Zoom Meeting';
        const startTime: string | undefined = object.start_time;
        const endTime: string | undefined = object.end_time || object.recording_files?.[0]?.recording_end;

        // Find the audio-only recording file (or fallback to first mp4)
        const recordingFiles: any[] = object.recording_files || [];
        const audioFile =
            recordingFiles.find((f: any) => f.recording_type === 'audio_only') ||
            recordingFiles.find((f: any) => f.file_type === 'MP4') ||
            recordingFiles[0];

        if (!audioFile?.download_url) {
            console.error('[zoom-webhook] No downloadable recording file found');
            res.status(200).json({ status: 'error', reason: 'No recording file' });
            return;
        }

        const meetingId = uuidv4();

        // Download recording from Zoom and upload to GCS
        const audioGcsPath = await downloadAndUploadZoomRecording(
            audioFile.download_url,
            meetingId,
            hostEmail,
        );

        // Create meeting record in Cloud SQL
        const pool = getPool();
        await pool.query(
            `INSERT INTO meetings (meeting_id, title, platform, start_time, end_time,
                                   owning_user, transcription_status, meeting_link)
             VALUES ($1, $2, 'zoom', $3, $4, $5, 'transcription_pending', $6)`,
            [meetingId, topic, startTime || null, endTime || null, hostEmail, `zoom://${object.id}`],
        );

        // Enqueue transcription task
        await enqueueTranscription({ meetingId, audioGcsPath, owningUser: hostEmail, retryCount: 0 });

        console.log(`[zoom-webhook] Processed recording for meeting ${meetingId}`);
        res.status(200).json({ status: 'processed', meetingId });
    } catch (err: any) {
        console.error(`[zoom-webhook] Error: ${err.message}`);
        res.status(500).json({ error: 'Failed to process Zoom recording' });
    }
});


// ─── Teams Webhook ───────────────────────────────────────────

/**
 * POST /api/webhooks/teams
 *
 * Handles Microsoft Graph change notifications:
 *   1. Validation request — Graph sends validationToken query param, echo it back
 *   2. Change notification — recording available for download
 */
router.post('/teams', async (req: Request, res: Response) => {
    // --- Graph subscription validation ---
    const validationToken = req.query.validationToken as string | undefined;
    if (validationToken) {
        res.set('Content-Type', 'text/plain');
        res.status(200).send(validationToken);
        return;
    }

    // --- Process change notifications ---
    const notifications: any[] = req.body?.value;
    if (!Array.isArray(notifications) || notifications.length === 0) {
        res.status(200).json({ status: 'ignored', reason: 'no notifications' });
        return;
    }

    // Acknowledge immediately — Graph expects 202 within 3 seconds
    res.status(202).json({ status: 'accepted' });

    // Process each notification asynchronously
    for (const notification of notifications) {
        try {
            await processTeamsNotification(notification);
        } catch (err: any) {
            console.error(`[teams-webhook] Error processing notification: ${err.message}`);
        }
    }
});

async function processTeamsNotification(notification: any): Promise<void> {
    const resourceData = notification.resourceData;
    if (!resourceData) {
        console.warn('[teams-webhook] Notification missing resourceData');
        return;
    }

    // The resource URL points to the recording content
    // e.g. communications/callRecords/{id}/content
    const recordingContentUrl = `https://graph.microsoft.com/v1.0/${notification.resource}/$value`;
    const organizerEmail: string =
        resourceData.organizerEmail ||
        notification.clientState ||
        'unknown@leverege.com';

    const meetingId = uuidv4();
    const title = resourceData.subject || 'Teams Meeting';
    const startTime = resourceData.startDateTime || null;
    const endTime = resourceData.endDateTime || null;

    // Download recording from Graph API and upload to GCS
    const audioGcsPath = await downloadAndUploadTeamsRecording(
        recordingContentUrl,
        meetingId,
        organizerEmail,
    );

    // Create meeting record
    const pool = getPool();
    await pool.query(
        `INSERT INTO meetings (meeting_id, title, platform, start_time, end_time,
                               owning_user, transcription_status)
         VALUES ($1, $2, 'teams', $3, $4, $5, 'transcription_pending')`,
        [meetingId, title, startTime, endTime, organizerEmail],
    );

    // Enqueue transcription
    await enqueueTranscription({ meetingId, audioGcsPath, owningUser: organizerEmail, retryCount: 0 });

    console.log(`[teams-webhook] Processed recording for meeting ${meetingId}`);
}


// ─── Shared: Enqueue Transcription Task ──────────────────────

/**
 * Create a Cloud Tasks entry to trigger the transcription worker.
 */
async function enqueueTranscription(task: TranscriptionTask): Promise<void> {
    const client = new CloudTasksClient();
    const parent = client.queuePath(PROJECT_ID, REGION, QUEUE_NAME);

    await client.createTask({
        parent,
        task: {
            httpRequest: {
                httpMethod: 'POST',
                url: WORKER_URL,
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from(JSON.stringify(task)).toString('base64'),
            },
        },
    });
}

export default router;
