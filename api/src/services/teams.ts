/**
 * Microsoft Teams service — Graph API client credentials flow + recording download.
 *
 * Credentials format in Secret Manager (microsoft-account-credentials):
 *   {"tenant_id":"...","client_id":"...","client_secret":"..."}
 *
 * Flow:
 *   1. POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *      with client_credentials grant and https://graph.microsoft.com/.default scope
 *   2. Use access_token to download recording via Graph API
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Storage } from '@google-cloud/storage';
import { hashUserEmail } from './workspace';

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'ai-meeting-notetaker-490206';
const AUDIO_BUCKET = process.env.AUDIO_BUCKET || 'leverege-notetaker-audio';

interface TeamsCredentials {
    tenant_id: string;
    client_id: string;
    client_secret: string;
}

interface GraphTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Fetch Teams/Graph credentials from Secret Manager.
 */
export async function getTeamsCredentials(): Promise<TeamsCredentials> {
    const client = new SecretManagerServiceClient();
    const name = `projects/${PROJECT_ID}/secrets/microsoft-account-credentials/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });
    const payload = version.payload?.data?.toString() || '{}';
    return JSON.parse(payload);
}

/**
 * Get a valid Microsoft Graph access token via client_credentials flow.
 * Caches the token until 60s before expiry.
 */
export async function getGraphAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
        return cachedToken.token;
    }

    const creds = await getTeamsCredentials();
    const tokenUrl = `https://login.microsoftonline.com/${creds.tenant_id}/oauth2/v2.0/token`;

    const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            scope: 'https://graph.microsoft.com/.default',
        }),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Graph OAuth failed (${resp.status}): ${text}`);
    }

    const data: GraphTokenResponse = await resp.json();

    cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };

    return data.access_token;
}

/**
 * Download a Teams meeting recording via Graph API and upload to GCS.
 *
 * @param recordingContentUrl - The Graph API URL for the recording content
 * @param meetingId - Our internal meeting ID
 * @param organizerEmail - The meeting organizer's email
 * @returns gs:// URI of the uploaded audio
 */
export async function downloadAndUploadTeamsRecording(
    recordingContentUrl: string,
    meetingId: string,
    organizerEmail: string,
): Promise<string> {
    const token = await getGraphAccessToken();

    const resp = await fetch(recordingContentUrl, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
        throw new Error(`Teams recording download failed (${resp.status})`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const userHash = hashUserEmail(organizerEmail);
    const gcsPath = `${userHash}/${meetingId}/audio.mp4`;

    const storage = new Storage();
    await storage.bucket(AUDIO_BUCKET).file(gcsPath).save(buffer, {
        contentType: 'video/mp4',
        metadata: { meeting_id: meetingId, source: 'teams' },
    });

    return `gs://${AUDIO_BUCKET}/${gcsPath}`;
}
