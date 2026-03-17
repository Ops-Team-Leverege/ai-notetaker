import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Secret Manager
vi.mock('@google-cloud/secret-manager', () => ({
    SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion: vi.fn().mockResolvedValue([{
            payload: {
                data: Buffer.from(JSON.stringify({
                    tenant_id: 'test-tenant',
                    client_id: 'test-client',
                    client_secret: 'test-secret',
                })),
            },
        }]),
    })),
}));

// Mock Storage
vi.mock('@google-cloud/storage', () => ({
    Storage: vi.fn().mockImplementation(() => ({
        bucket: vi.fn().mockReturnValue({
            file: vi.fn().mockReturnValue({
                save: vi.fn().mockResolvedValue(undefined),
            }),
        }),
    })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

let teamsModule: typeof import('./teams');

describe('Teams Service', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mockFetch.mockReset();
        vi.resetModules();
        teamsModule = await import('./teams');
    });

    describe('getTeamsCredentials', () => {
        it('should fetch credentials from Secret Manager', async () => {
            const creds = await teamsModule.getTeamsCredentials();
            expect(creds).toEqual({
                tenant_id: 'test-tenant',
                client_id: 'test-client',
                client_secret: 'test-secret',
            });
        });
    });

    describe('getGraphAccessToken', () => {
        it('should exchange credentials for a Graph access token', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'graph-token-123',
                    token_type: 'bearer',
                    expires_in: 3600,
                }),
            });

            const token = await teamsModule.getGraphAccessToken();
            expect(token).toBe('graph-token-123');

            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('login.microsoftonline.com/test-tenant/oauth2/v2.0/token'),
                expect.objectContaining({ method: 'POST' }),
            );
        });

        it('should throw on OAuth failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: async () => 'Bad Request',
            });

            await expect(teamsModule.getGraphAccessToken()).rejects.toThrow('Graph OAuth failed (400)');
        });
    });

    describe('downloadAndUploadTeamsRecording', () => {
        it('should download recording and upload to GCS', async () => {
            // OAuth token
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'graph-token-456',
                    token_type: 'bearer',
                    expires_in: 3600,
                }),
            });

            // Recording download
            const fakeAudio = new ArrayBuffer(2048);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => fakeAudio,
            });

            const gcsUri = await teamsModule.downloadAndUploadTeamsRecording(
                'https://graph.microsoft.com/v1.0/communications/callRecords/abc/$value',
                'meeting-t01',
                'organizer@example.com',
            );

            expect(gcsUri).toMatch(/^gs:\/\/leverege-notetaker-audio\/.+\/meeting-t01\/audio\.mp4$/);
        });

        it('should throw on download failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'graph-token-789',
                    token_type: 'bearer',
                    expires_in: 3600,
                }),
            });

            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 403,
            });

            await expect(
                teamsModule.downloadAndUploadTeamsRecording(
                    'https://graph.microsoft.com/v1.0/bad',
                    'meeting-t02',
                    'organizer@example.com',
                ),
            ).rejects.toThrow('Teams recording download failed (403)');
        });
    });
});
