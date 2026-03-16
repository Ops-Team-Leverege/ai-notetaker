import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initiateLogin, validateSession, logout, cleanupExpiredSessions } from './auth';
import { setPool } from '../db';

// Mock pool for database tests
function createMockPool(queryFn: (...args: any[]) => any) {
    return { query: vi.fn(queryFn) } as any;
}

describe('Auth Service', () => {
    describe('initiateLogin', () => {
        it('should return a Google OAuth URL with correct scopes', () => {
            const url = initiateLogin('http://localhost:8080/api/auth/callback', 'test-client-id');
            expect(url).toContain('accounts.google.com');
            expect(url).toContain('scope=');
            expect(url).toContain('openid');
            expect(url).toContain('email');
            expect(url).toContain('profile');
            expect(url).toContain('redirect_uri=');
            expect(url).toContain('client_id=test-client-id');
        });

        it('should include the redirect URI in the authorization URL', () => {
            const redirectUri = 'https://app.example.com/api/auth/callback';
            const url = initiateLogin(redirectUri, 'test-client-id');
            expect(url).toContain(encodeURIComponent(redirectUri));
        });
    });

    describe('validateSession', () => {
        it('should return user when session is valid and not expired', async () => {
            const futureDate = new Date(Date.now() + 3600000);
            const mockPool = createMockPool(() => ({
                rows: [{ user_email: 'user@test.com', user_name: 'Test User', expires_at: futureDate }],
            }));
            setPool(mockPool);

            const user = await validateSession('valid-token');
            expect(user).toEqual({ email: 'user@test.com', name: 'Test User' });
            expect(mockPool.query).toHaveBeenCalledWith(
                'SELECT user_email, user_name, expires_at FROM sessions WHERE token = $1',
                ['valid-token']
            );
        });

        it('should return null when session token does not exist', async () => {
            const mockPool = createMockPool(() => ({ rows: [] }));
            setPool(mockPool);

            const user = await validateSession('nonexistent-token');
            expect(user).toBeNull();
        });

        it('should return null and delete session when expired', async () => {
            const pastDate = new Date(Date.now() - 3600000);
            const mockPool = createMockPool(() => ({
                rows: [{ user_email: 'user@test.com', user_name: 'Test User', expires_at: pastDate }],
            }));
            setPool(mockPool);

            const user = await validateSession('expired-token');
            expect(user).toBeNull();
            // Should have called DELETE for the expired session
            expect(mockPool.query).toHaveBeenCalledTimes(2);
            expect(mockPool.query).toHaveBeenCalledWith(
                'DELETE FROM sessions WHERE token = $1',
                ['expired-token']
            );
        });
    });

    describe('logout', () => {
        it('should delete the session from the database', async () => {
            const mockPool = createMockPool(() => ({ rowCount: 1 }));
            setPool(mockPool);

            await logout('session-token');
            expect(mockPool.query).toHaveBeenCalledWith(
                'DELETE FROM sessions WHERE token = $1',
                ['session-token']
            );
        });
    });

    describe('cleanupExpiredSessions', () => {
        it('should delete expired sessions and return count', async () => {
            const mockPool = createMockPool(() => ({ rowCount: 5 }));
            setPool(mockPool);

            const count = await cleanupExpiredSessions();
            expect(count).toBe(5);
            expect(mockPool.query).toHaveBeenCalledWith('DELETE FROM sessions WHERE expires_at < NOW()');
        });

        it('should return 0 when no expired sessions exist', async () => {
            const mockPool = createMockPool(() => ({ rowCount: 0 }));
            setPool(mockPool);

            const count = await cleanupExpiredSessions();
            expect(count).toBe(0);
        });
    });
});
