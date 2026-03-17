import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Secret Manager
vi.mock('@google-cloud/secret-manager', () => ({
    SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
        accessSecretVersion: vi.fn().mockResolvedValue([{
            payload: {
                data: Buffer.from(JSON.stringify({
                    account_id: 'test-account',
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

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// We need to reset the module-level token cache between tests
let zoomModule: typeof import('./zoom');

describe('Zoom Service', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mockFetch.mockReset();
        // Re-import to reset cached token
        vi.resetModules();
        zoomModule = await import('./zoom');
    });

    describe('getZoomCredentials', () => {
        it('should fetch credentials from Secret Manager', async () => {
            const creds = await zoomModule.getZoomCredentials();
            expect(creds).toEqual({
                account_id: 'test-account',
                client_id: 'test-client',
                client_secret: 'test-secret',
            });
        });
    });

    describe('getZoomAccessToken', () => {
        it('should exchange credentials for an access token', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'zoom-token-123',
                    token_type: 'bearer',
                    expires_in: 3600,
                }),
            });

            const token = await zoomModule.getZoomAccessToken();
            expect(token).toBe('zoom-token-123');

            // Verify the fetch call
            expect(mockFetch).toHaveBeenCalledWith(
                'https://zoom.us/oauth/token',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/x-www-form-urlencoded',
                    }),
                }),
            );
        });

        it('should throw on OAuth failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 401,
                text: async () => 'Unauthorized',
            });

            await expect(zoomModule.getZoomAccessToken()).rejects.toThrow('Zoom OAuth failed (401)');
        });
    });

    describe('downloadAndUploadZoomRecording', () => {
        it('should download recording and upload to GCS', async () => {
            // First call: OAuth token
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'zoom-token-456',
                    token_type: 'bearer',
                    expires_in: 3600,
                }),
            });

            // Second call: recording download
            const fakeAudio = new ArrayBuffer(1024);
            mockFetch.mockResolvedValueOnce({
                ok: true,
                arrayBuffer: async () => fakeAudio,
            });

            const gcsUri = await zoomModule.downloadAndUploadZoomRecording(
                'https://zoom.us/rec/download/abc123',
                'meeting-001',
                'host@example.com',
            );

            expect(gcsUri).toMatch(/^gs:\/\/leverege-notetaker-audio\/.+\/meeting-001\/audio\.mp4$/);
        });

        it('should throw on download failure', async () => {
            // OAuth token
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'zoom-token-789',
                    token_type: 'bearer',
                    expires_in: 3600,
                }),
            });

            // Download fails
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
            });

            await expect(
                zoomModule.downloadAndUploadZoomRecording(
                    'https://zoom.us/rec/download/bad',
                    'meeting-002',
                    'host@example.com',
                ),
            ).rejects.toThrow('Zoom recording download failed (404)');
        });
    });
});
