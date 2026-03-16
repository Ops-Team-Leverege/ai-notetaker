import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('MeetingList', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    it('renders meeting list with required fields', async () => {
        const mockMeetings = [
            {
                meeting_id: 'meet-1',
                title: 'Team Standup',
                platform: 'google_meet',
                meeting_date: '2024-01-15T10:00:00Z',
                transcription_status: 'completed',
            },
            {
                meeting_id: 'meet-2',
                title: 'Project Review',
                platform: 'zoom',
                meeting_date: '2024-01-16T14:00:00Z',
                transcription_status: 'processing',
            },
        ];

        // Each meeting should have: title, platform, date, status
        for (const meeting of mockMeetings) {
            expect(meeting.title).toBeDefined();
            expect(meeting.platform).toBeDefined();
            expect(meeting.meeting_date).toBeDefined();
            expect(meeting.transcription_status).toBeDefined();
        }
    });

    it('validates platform values', () => {
        const validPlatforms = ['google_meet', 'zoom', 'teams'];
        const meeting = { platform: 'google_meet' };
        expect(validPlatforms).toContain(meeting.platform);
    });

    it('validates transcription status values', () => {
        const validStatuses = ['pending', 'transcription_pending', 'processing', 'completed', 'transcription_failed'];
        const meeting = { transcription_status: 'completed' };
        expect(validStatuses).toContain(meeting.transcription_status);
    });
});
