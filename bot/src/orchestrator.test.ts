import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MeetingBot
vi.mock('./bot', () => ({
    MeetingBot: vi.fn().mockImplementation(() => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
    })),
}));

import { dispatchBot, getBotStatus, stopBot, streamStatus } from './orchestrator';

describe('Bot Orchestrator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('dispatchBot', () => {
        it('creates a new session for a meeting', async () => {
            const session = await dispatchBot({
                meetingId: 'test-meeting-1',
                meetingUrl: 'https://meet.google.com/abc-defg-hij',
                platform: 'google_meet',
                owningUser: 'user@test.com',
            });

            expect(session.meetingId).toBe('test-meeting-1');
            expect(session.status).toBe('joining');
            expect(session.platform).toBe('google_meet');
        });

        it('returns existing session if already dispatched', async () => {
            const session1 = await dispatchBot({
                meetingId: 'test-meeting-2',
                meetingUrl: 'https://meet.google.com/abc-defg-hij',
                platform: 'google_meet',
                owningUser: 'user@test.com',
            });

            const session2 = await dispatchBot({
                meetingId: 'test-meeting-2',
                meetingUrl: 'https://meet.google.com/abc-defg-hij',
                platform: 'google_meet',
                owningUser: 'user@test.com',
            });

            expect(session1).toBe(session2);
        });
    });

    describe('getBotStatus', () => {
        it('returns null for unknown meeting', () => {
            const status = getBotStatus('unknown-meeting');
            expect(status).toBeNull();
        });

        it('returns session for known meeting', async () => {
            await dispatchBot({
                meetingId: 'test-meeting-3',
                meetingUrl: 'https://zoom.us/j/123456',
                platform: 'zoom',
                owningUser: 'user@test.com',
            });

            const status = getBotStatus('test-meeting-3');
            expect(status).not.toBeNull();
            expect(status?.meetingId).toBe('test-meeting-3');
        });
    });

    describe('streamStatus', () => {
        it('returns unsubscribe function', async () => {
            await dispatchBot({
                meetingId: 'test-meeting-4',
                meetingUrl: 'https://teams.microsoft.com/l/meetup-join/123',
                platform: 'teams',
                owningUser: 'user@test.com',
            });

            const callback = vi.fn();
            const unsubscribe = streamStatus('test-meeting-4', callback);

            expect(typeof unsubscribe).toBe('function');
            unsubscribe();
        });

        it('returns no-op for unknown meeting', () => {
            const callback = vi.fn();
            const unsubscribe = streamStatus('unknown-meeting', callback);

            expect(typeof unsubscribe).toBe('function');
            unsubscribe(); // Should not throw
        });
    });
});
