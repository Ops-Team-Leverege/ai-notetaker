import React, { useState } from 'react';

interface Props {
    onSuccess: () => void;
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export function MeetingSubmitForm({ onSuccess }: Props) {
    const [meetingLink, setMeetingLink] = useState('');
    const [passcode, setPasscode] = useState('');
    const [botName, setBotName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function detectPlatform(url: string): string | null {
        try {
            const parsed = new URL(url);
            const host = parsed.hostname.toLowerCase();
            if (host === 'meet.google.com') return 'google_meet';
            if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
            if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'teams';
        } catch { /* ignore */ }
        return null;
    }

    const platform = detectPlatform(meetingLink);
    const isTeams = platform === 'teams';
    const isZoom = platform === 'zoom';

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!meetingLink.trim() || isTeams) return;

        setSubmitting(true);
        setError(null);

        try {
            const body: Record<string, string> = { meetingLink: meetingLink.trim() };
            if (passcode.trim()) body.passcode = passcode.trim();
            if (botName.trim()) body.botName = botName.trim();

            const res = await fetch(`${API_BASE}/meetings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to submit meeting');
            }

            setMeetingLink('');
            setPasscode('');
            setBotName('');
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="meeting-submit-form">
            <div className="form-row">
                <input
                    type="url"
                    value={meetingLink}
                    onChange={(e) => setMeetingLink(e.target.value)}
                    placeholder="Paste meeting link (Google Meet, Zoom, or Teams)"
                    disabled={submitting}
                    aria-label="Meeting link"
                />
                <button type="submit" disabled={submitting || !meetingLink.trim() || isTeams}>
                    {submitting ? 'Submitting...' : 'Add Meeting'}
                </button>
            </div>

            {isTeams && (
                <div className="teams-notice">Teams bot coming soon</div>
            )}

            <div className="form-extras">
                {isZoom && (
                    <input
                        type="text"
                        value={passcode}
                        onChange={(e) => setPasscode(e.target.value)}
                        placeholder="Passcode (optional)"
                        disabled={submitting}
                        aria-label="Meeting passcode"
                        className="input-small"
                    />
                )}
                <input
                    type="text"
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                    placeholder="Bot display name (default: Leverege Notetaker)"
                    disabled={submitting || isTeams}
                    aria-label="Bot display name"
                    className="input-small"
                />
            </div>

            {error && <div className="form-error" role="alert">{error}</div>}
        </form>
    );
}
