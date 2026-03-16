/**
 * Credentials management - fetches platform credentials from Secret Manager.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { Platform } from './types';

const client = new SecretManagerServiceClient();
const PROJECT_ID = process.env.GCP_PROJECT_ID || 'ai-meeting-notetaker-490206';

const SECRET_NAMES: Record<Platform, string> = {
    google_meet: 'google-oauth-credentials',
    zoom: 'zoom-account-credentials',
    teams: 'microsoft-account-credentials',
};

const credentialsCache = new Map<Platform, Record<string, string>>();

/**
 * Get credentials for a platform from Secret Manager.
 */
export async function getCredentials(platform: Platform): Promise<Record<string, string>> {
    // Check cache first
    if (credentialsCache.has(platform)) {
        return credentialsCache.get(platform)!;
    }

    const secretName = SECRET_NAMES[platform];
    const name = `projects/${PROJECT_ID}/secrets/${secretName}/versions/latest`;

    try {
        const [version] = await client.accessSecretVersion({ name });
        const payload = version.payload?.data?.toString() || '{}';
        const credentials = JSON.parse(payload);

        credentialsCache.set(platform, credentials);
        return credentials;
    } catch (err) {
        console.error(`Failed to fetch credentials for ${platform}:`, err);
        return {};
    }
}
