/**
 * Zoom S2S OAuth service — token exchange and recording download.
 *
 * Credentials format in Secret Manager (zoom-account-credentials):
 *   {"account_id":"...","client_id":"...","client_secret":"..."}
 *
 * Flow:
 *   1. POST https://zoom.us/oauth/token with account_credentials grant
 *   2. Use access_token to download cloud recording files
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Storage } from '@google-cloud/storage';
import { hashUserEmail } from './workspace';

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'ai-meeting-notetaker-490206';
const AUDIO_BUCKET = process.env.AUDIO_BUCKET || 'leverege-notetaker-audio';

interface ZoomCredentials {
    account_id: string;
    client_id: string;
    client_secret: string;
}

interface ZoomTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Fetch Zoom S2S OAuth credentials from Secret Manager.
 */
export async function getZoomCredentials(): Promise<ZoomCredentials> {
    const client = new SecretManagerServiceClient();
    const name = `projects/${PROJECT_ID}/secrets/zoom-account-credentials/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });
    const payload = version.payload?.data?.toString() || '{}';
    return JSON.parse(payload);
}

/**
 * Get a valid Zoom S2S OAuth access token.
 * Caches the token until 60s before expiry.
 */
export async function getZoomAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
        return cachedToken.token;
    }

    const creds = await getZoomCredentials();
    const basicAuth = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');

    const resp = await fetch('https://zoom.us/oauth/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'account_credentials',
            account_id: creds.account_id,
        }),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Zoom OAuth failed (${resp.status}): ${text}`);
    }

    const data = (await resp.json()) as ZoomTokenResponse;

    // Cache with 60s buffer before expiry
    cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };

    return data.access_token;
}

/**
 * Download a Zoom cloud recording file and upload it to GCS.
 *
 * @param downloadUrl - The Zoom recording download_url
 * @param meetingId - Our internal meeting ID
 * @param hostEmail - The meeting host's email (for user-scoped GCS path)
 * @returns gs:// URI of the uploaded audio
 */
export async function downloadAndUploadZoomRecording(
    downloadUrl: string,
    meetingId: string,
    hostEmail: string,
): Promise<string> {
    const token = await getZoomAccessToken();

    // Zoom download URLs require the access token as a query param
    const url = new URL(downloadUrl);
    url.searchParams.set('access_token', token);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
        throw new Error(`Zoom recording download failed (${resp.status})`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Upload to GCS under user-scoped path
    const userHash = hashUserEmail(hostEmail);
    const gcsPath = `${userHash}/${meetingId}/audio.mp4`;

    const storage = new Storage();
    await storage.bucket(AUDIO_BUCKET).file(gcsPath).save(buffer, {
        contentType: 'video/mp4',
        metadata: { meeting_id: meetingId, source: 'zoom' },
    });

    return `gs://${AUDIO_BUCKET}/${gcsPath}`;
}
