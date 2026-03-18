import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { MeetingSubmitForm } from './MeetingSubmitForm';

interface Meeting {
    meetingId: string;
    title: string;
    platform: 'google_meet' | 'zoom' | 'teams';
    transcriptionStatus: string;
    createdAt: string;
    updatedAt: string;
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const platformLabels: Record<string, string> = {
    google_meet: 'Google Meet',
    zoom: 'Zoom',
    teams: 'Teams',
};

const platformColors: Record<string, string> = {
    google_meet: '#0f9d58',
    zoom: '#2d8cff',
    teams: '#6264a7',
};

const statusLabels: Record<string, string> = {
    pending: 'Pending',
    joining: 'Joining',
    transcription_pending: 'Queued',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    transcription_failed: 'Failed',
};

export function MeetingList() {
    const { user, logout } = useAuth();
    const [meetings, setMeetings] = useState<Meeting[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchMeetings();
    }, []);

    async function fetchMeetings() {
        try {
            const res = await fetch(`${API_BASE}/meetings`, {
                credentials: 'include',
            });
            if (!res.ok) throw new Error('Failed to fetch meetings');
            const data = await res.json();
            setMeetings(Array.isArray(data) ? data : []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }

    if (loading) return <div className="loading">Loading meetings...</div>;

    return (
        <div className="meeting-list-container">
            <header>
                <h1>My Meetings</h1>
                <div className="user-info">
                    <span>{user?.email}</span>
                    <button onClick={logout}>Sign out</button>
                </div>
            </header>

            <MeetingSubmitForm onSuccess={fetchMeetings} />

            {error && <div className="error" role="alert">{error}</div>}

            {meetings.length === 0 ? (
                <p className="empty-state">No meetings yet. Submit a meeting link above to get started.</p>
            ) : (
                <ul className="meeting-list">
                    {meetings.map((m) => (
                        <li key={m.meetingId} className="meeting-item">
                            <div className="meeting-card">
                                <div className="meeting-card-top">
                                    <span
                                        className="platform-badge"
                                        style={{ background: platformColors[m.platform] || '#666' }}
                                    >
                                        {platformLabels[m.platform] || m.platform}
                                    </span>
                                    <span className={`status status-${m.transcriptionStatus}`}>
                                        {statusLabels[m.transcriptionStatus] || m.transcriptionStatus}
                                    </span>
                                </div>
                                <div className="meeting-title">{m.title || 'Untitled Meeting'}</div>
                                <div className="meeting-date">
                                    {new Date(m.createdAt).toLocaleDateString(undefined, {
                                        year: 'numeric', month: 'short', day: 'numeric',
                                        hour: '2-digit', minute: '2-digit',
                                    })}
                                </div>
                                {m.transcriptionStatus === 'completed' && (
                                    <Link to={`/meetings/${m.meetingId}`} className="transcript-link">
                                        View transcript →
                                    </Link>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
