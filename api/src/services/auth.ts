import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { getPool } from '../db';
import { Session, User } from '../types';

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

interface OAuthCredentials {
    clientId: string;
    clientSecret: string;
}

let cachedCredentials: OAuthCredentials | null = null;
let oauthClient: OAuth2Client | null = null;

async function getOAuthCredentials(): Promise<OAuthCredentials> {
    if (cachedCredentials) return cachedCredentials;

    const secretManager = new SecretManagerServiceClient();
    const projectId = process.env.GCP_PROJECT_ID || '';

    const [clientIdVersion] = await secretManager.accessSecretVersion({
        name: `projects/${projectId}/secrets/google-oauth-client-id/versions/latest`,
    });
    const [clientSecretVersion] = await secretManager.accessSecretVersion({
        name: `projects/${projectId}/secrets/google-oauth-client-secret/versions/latest`,
    });

    cachedCredentials = {
        clientId: clientIdVersion.payload?.data?.toString() || '',
        clientSecret: clientSecretVersion.payload?.data?.toString() || '',
    };

    return cachedCredentials;
}

async function getOAuthClient(redirectUri?: string): Promise<OAuth2Client> {
    if (oauthClient && !redirectUri) return oauthClient;

    const creds = await getOAuthCredentials();
    const client = new OAuth2Client(creds.clientId, creds.clientSecret, redirectUri);

    if (!redirectUri) {
        oauthClient = client;
    }

    return client;
}

/**
 * Build Google OAuth 2.0 authorization URL with OpenID Connect scopes.
 */
export function initiateLogin(redirectUri: string, clientId: string): string {
    const client = new OAuth2Client(clientId, undefined, redirectUri);
    const authorizeUrl = client.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        prompt: 'select_account',
    });
    return authorizeUrl;
}

/**
 * Exchange authorization code for tokens, extract user info, create session in Cloud SQL.
 */
export async function handleCallback(code: string, redirectUri: string): Promise<Session> {
    const creds = await getOAuthCredentials();
    const client = new OAuth2Client(creds.clientId, creds.clientSecret, redirectUri);

    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const idToken = tokens.id_token;
    if (!idToken) {
        throw new Error('No ID token received from Google');
    }

    const ticket = await client.verifyIdToken({
        idToken,
        audience: creds.clientId,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
        throw new Error('Invalid ID token payload');
    }

    const user: User = {
        email: payload.email,
        name: payload.name || payload.email,
        picture: payload.picture,
    };

    const token = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    const pool = getPool();
    await pool.query(
        'INSERT INTO sessions (token, user_email, user_name, expires_at) VALUES ($1, $2, $3, $4)',
        [token, user.email, user.name, expiresAt]
    );

    return { token, user, expiresAt };
}

/**
 * Look up session token in Cloud SQL, check expiry, return User | null.
 */
export async function validateSession(token: string): Promise<User | null> {
    const pool = getPool();
    const result = await pool.query(
        'SELECT user_email, user_name, expires_at FROM sessions WHERE token = $1',
        [token]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const expiresAt = new Date(row.expires_at);

    if (expiresAt <= new Date()) {
        // Session expired — clean it up
        await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
        return null;
    }

    return {
        email: row.user_email,
        name: row.user_name,
    };
}

/**
 * Delete session row from Cloud SQL.
 */
export async function logout(token: string): Promise<void> {
    const pool = getPool();
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

/**
 * Delete all expired sessions. Called by Cloud Scheduler nightly.
 */
export async function cleanupExpiredSessions(): Promise<number> {
    const pool = getPool();
    const result = await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
    return result.rowCount ?? 0;
}

/**
 * Fetch OAuth credentials from Secret Manager (for use in routes).
 */
export async function getClientCredentials(): Promise<OAuthCredentials> {
    return getOAuthCredentials();
}
