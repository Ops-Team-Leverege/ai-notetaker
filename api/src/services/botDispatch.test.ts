import { describe, it, expect } from 'vitest';
import { parseZoomUrl } from './botDispatch';

describe('parseZoomUrl', () => {
    it('extracts meeting number and passcode from standard Zoom URL', () => {
        const result = parseZoomUrl('https://zoom.us/j/1234567890?pwd=abc123');
        expect(result.meetingNumber).toBe('1234567890');
        expect(result.passcode).toBe('abc123');
    });

    it('extracts meeting number from subdomain Zoom URL', () => {
        const result = parseZoomUrl('https://us02.zoom.us/j/9876543210?pwd=xyz');
        expect(result.meetingNumber).toBe('9876543210');
        expect(result.passcode).toBe('xyz');
    });

    it('returns empty passcode when pwd param is missing', () => {
        const result = parseZoomUrl('https://zoom.us/j/1234567890');
        expect(result.meetingNumber).toBe('1234567890');
        expect(result.passcode).toBe('');
    });

    it('returns empty meeting number for non-standard path', () => {
        const result = parseZoomUrl('https://zoom.us/meeting/1234567890');
        expect(result.meetingNumber).toBe('');
    });
});
