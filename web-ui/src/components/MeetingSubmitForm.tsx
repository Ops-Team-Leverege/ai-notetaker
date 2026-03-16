import React, { useState } from 'react';

interface Props {
    onSuccess: () => void;
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export function MeetingSubmitForm({ onSuccess }: Props) {
    const [meetingLink, setMeetingLink] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!meetingLink.trim()) return;

        setSubmitting(true);
        setError(null);

        try {
            const res = await fetch(`${API_BASE}/meetings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ meetingLink: meetingLink.trim() }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to submit meeting');
            }

            setMeetingLink('');
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="meeting-submit-form">
            <input
                type="url"
                value={meetingLink}
                onChange={(e) => setMeetingLink(e.target.value)}
                placeholder="Paste meeting link (Google Meet, Zoom, or Teams)"
                disabled={submitting}
                aria-label="Meeting link"
            />
            <button type="submit" disabled={submitting || !meetingLink.trim()}>
                {submitting ? 'Submitting...' : 'Add Meeting'}
            </button>
            {error && <div className="form-error">{error}</div>}
        </form>
    );
}
