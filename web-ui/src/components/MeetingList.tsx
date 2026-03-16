import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { MeetingSubmitForm } from './MeetingSubmitForm';

interface Meeting {
    meeting_id: string;
    title: string;
    platform: 'google_meet' | 'zoom' | 'teams';
    meeting_date: string;
    transcription_status: string;
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

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
            setMeetings(data.meetings || []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }

    function handleMeetingCreated() {
        fetchMeetings();
    }

    const platformLabels: Record<string, string> = {
        google_meet: 'Google Meet',
        zoom: 'Zoom',
        teams: 'Microsoft Teams',
    };

    const statusLabels: Record<string, string> = {
        pending: 'Pending',
        transcription_pending: 'Queued',
        processing: 'Processing',
        completed: 'Completed',
        transcription_failed: 'Failed',
    };

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

            <MeetingSubmitForm onSuccess={handleMeetingCreated} />

            {error && <div className="error">{error}</div>}

            {meetings.length === 0 ? (
                <p>No meetings yet. Submit a meeting link above to get started.</p>
            ) : (
                <ul className="meeting-list">
                    {meetings.map((meeting) => (
                        <li key={meeting.meeting_id} className="meeting-item">
                            <Link to={`/meetings/${meeting.meeting_id}`}>
                                <div className="meeting-title">{meeting.title || 'Untitled Meeting'}</div>
                                <div className="meeting-meta">
                                    <span className="platform">{platformLabels[meeting.platform] || meeting.platform}</span>
                                    <span className="date">{new Date(meeting.meeting_date).toLocaleDateString()}</span>
                                    <span className={`status status-${meeting.transcription_status}`}>
                                        {statusLabels[meeting.transcription_status] || meeting.transcription_status}
                                    </span>
                                </div>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
