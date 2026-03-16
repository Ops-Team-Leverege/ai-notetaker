import { describe, it, expect } from 'vitest';
import { detectPlatform, mergeSpeakerLabels } from './meetings';
import { TranscriptEntry } from '../types';

describe('detectPlatform', () => {
    // Google Meet
    it('detects Google Meet URLs', () => {
        expect(detectPlatform('https://meet.google.com/abc-defg-hij')).toBe('google_meet');
    });

    // Zoom
    it('detects Zoom URLs (zoom.us)', () => {
        expect(detectPlatform('https://zoom.us/j/1234567890')).toBe('zoom');
    });

    it('detects Zoom URLs (subdomain)', () => {
        expect(detectPlatform('https://us02.zoom.us/j/1234567890?pwd=abc')).toBe('zoom');
    });

    // Teams
    it('detects Teams URLs (teams.microsoft.com)', () => {
        expect(
            detectPlatform('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc'),
        ).toBe('teams');
    });

    it('detects Teams URLs (teams.live.com)', () => {
        expect(detectPlatform('https://teams.live.com/meet/abc123')).toBe('teams');
    });

    // Rejection cases
    it('throws on unsupported URL', () => {
        expect(() => detectPlatform('https://example.com/meeting')).toThrow(
            'Unsupported meeting platform',
        );
    });

    it('throws on invalid URL', () => {
        expect(() => detectPlatform('not-a-url')).toThrow('Invalid URL');
    });

    it('throws on empty string', () => {
        expect(() => detectPlatform('')).toThrow('Invalid URL');
    });

    it('rejects zoom.us without /j/ path', () => {
        expect(() => detectPlatform('https://zoom.us/meeting/123')).toThrow(
            'Unsupported meeting platform',
        );
    });

    it('rejects teams.microsoft.com without /l/meetup-join/ path', () => {
        expect(() => detectPlatform('https://teams.microsoft.com/other/path')).toThrow(
            'Unsupported meeting platform',
        );
    });
});


describe('mergeSpeakerLabels', () => {
    const baseTranscript: TranscriptEntry[] = [
        { speaker: 'Speaker 1', text: "Let's begin.", timestamp: '2026-03-13T14:00:05Z' },
        { speaker: 'Speaker 2', text: 'Sounds good.', timestamp: '2026-03-13T14:00:12Z' },
        { speaker: 'Speaker 1', text: 'First item.', timestamp: '2026-03-13T14:00:20Z' },
    ];

    it('replaces speakers that have a custom label mapping', () => {
        const labels = [{ original_label: 'Speaker 1', custom_label: 'Alice' }];
        const result = mergeSpeakerLabels(baseTranscript, labels);

        expect(result[0].speaker).toBe('Alice');
        expect(result[1].speaker).toBe('Speaker 2'); // unchanged
        expect(result[2].speaker).toBe('Alice');
    });

    it('leaves speakers unchanged when no mapping exists', () => {
        const result = mergeSpeakerLabels(baseTranscript, []);

        expect(result[0].speaker).toBe('Speaker 1');
        expect(result[1].speaker).toBe('Speaker 2');
        expect(result[2].speaker).toBe('Speaker 1');
    });

    it('handles multiple speaker label mappings', () => {
        const labels = [
            { original_label: 'Speaker 1', custom_label: 'Alice' },
            { original_label: 'Speaker 2', custom_label: 'Bob' },
        ];
        const result = mergeSpeakerLabels(baseTranscript, labels);

        expect(result[0].speaker).toBe('Alice');
        expect(result[1].speaker).toBe('Bob');
        expect(result[2].speaker).toBe('Alice');
    });

    it('ignores mappings with null custom_label', () => {
        const labels = [{ original_label: 'Speaker 1', custom_label: null }];
        const result = mergeSpeakerLabels(baseTranscript, labels);

        expect(result[0].speaker).toBe('Speaker 1');
    });

    it('does not mutate the original transcript', () => {
        const labels = [{ original_label: 'Speaker 1', custom_label: 'Alice' }];
        const original = JSON.parse(JSON.stringify(baseTranscript));
        mergeSpeakerLabels(baseTranscript, labels);

        expect(baseTranscript).toEqual(original);
    });

    it('preserves text and timestamp fields', () => {
        const labels = [{ original_label: 'Speaker 1', custom_label: 'Alice' }];
        const result = mergeSpeakerLabels(baseTranscript, labels);

        expect(result[0].text).toBe("Let's begin.");
        expect(result[0].timestamp).toBe('2026-03-13T14:00:05Z');
    });

    it('handles empty transcript', () => {
        const result = mergeSpeakerLabels([], [{ original_label: 'Speaker 1', custom_label: 'Alice' }]);
        expect(result).toEqual([]);
    });

    it('handles mappings for speakers not in transcript', () => {
        const labels = [{ original_label: 'Speaker 99', custom_label: 'Nobody' }];
        const result = mergeSpeakerLabels(baseTranscript, labels);

        expect(result).toEqual(baseTranscript);
    });
});
