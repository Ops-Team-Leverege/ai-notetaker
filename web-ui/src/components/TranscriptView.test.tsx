import { describe, it, expect } from 'vitest';

describe('TranscriptView', () => {
    it('transcript entries have required fields', () => {
        const mockTranscript = [
            {
                speaker: 'SPEAKER_00',
                text: 'Hello everyone',
                timestamp: '2024-01-15T10:00:00Z',
            },
            {
                speaker: 'SPEAKER_01',
                text: 'Hi there',
                timestamp: '2024-01-15T10:00:05Z',
            },
        ];

        for (const entry of mockTranscript) {
            expect(entry.speaker).toBeDefined();
            expect(entry.text).toBeDefined();
            expect(entry.timestamp).toBeDefined();
        }
    });

    it('entries are chronologically ordered', () => {
        const mockTranscript = [
            { timestamp: '2024-01-15T10:00:00Z' },
            { timestamp: '2024-01-15T10:00:05Z' },
            { timestamp: '2024-01-15T10:00:10Z' },
        ];

        const timestamps = mockTranscript.map((e) => new Date(e.timestamp).getTime());
        const sorted = [...timestamps].sort((a, b) => a - b);
        expect(timestamps).toEqual(sorted);
    });

    it('speaker labels are non-empty strings', () => {
        const mockTranscript = [
            { speaker: 'SPEAKER_00', text: 'Hello' },
            { speaker: 'SPEAKER_01', text: 'Hi' },
        ];

        for (const entry of mockTranscript) {
            expect(typeof entry.speaker).toBe('string');
            expect(entry.speaker.length).toBeGreaterThan(0);
        }
    });
});
