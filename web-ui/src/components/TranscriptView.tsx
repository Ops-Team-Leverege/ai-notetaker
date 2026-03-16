import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { BotStatusBanner } from './BotStatusBanner';

interface TranscriptEntry {
    speaker: string;
    text: string;
    timestamp: string;
}

interface Meeting {
    meeting_id: string;
    title: string;
    platform: string;
    transcription_status: string;
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// Speaker colors for visual distinction
const SPEAKER_COLORS = [
    '#4285f4', '#ea4335', '#fbbc04', '#34a853',
    '#ff6d01', '#46bdc6', '#7baaf7', '#f07b72',
];

export function TranscriptView() {
    const { id } = useParams<{ id: string }>();
    const [meeting, setMeeting] = useState<Meeting | null>(null);
    const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
    const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');

    useEffect(() => {
        if (id) {
            fetchMeeting();
            fetchTranscript();
        }
    }, [id]);

    async function fetchMeeting() {
        try {
            const res = await fetch(`${API_BASE}/meetings/${id}`, {
                credentials: 'include',
            });
            if (!res.ok) throw new Error('Failed to fetch meeting');
            const data = await res.json();
            setMeeting(data.meeting);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        }
    }

    async function fetchTranscript() {
        try {
            const res = await fetch(`${API_BASE}/meetings/${id}/transcript`, {
                credentials: 'include',
            });
            if (res.status === 404) {
                // Transcript not yet available
                setTranscript([]);
                return;
            }
            if (!res.ok) throw new Error('Failed to fetch transcript');
            const data = await res.json();
            setTranscript(data.transcript || []);
            // Build speaker labels map from transcript
            const labels: Record<string, string> = {};
            (data.transcript || []).forEach((entry: TranscriptEntry) => {
                if (!labels[entry.speaker]) {
                    labels[entry.speaker] = entry.speaker;
                }
            });
            setSpeakerLabels(labels);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }


    function getSpeakerColor(speaker: string): string {
        const speakers = Object.keys(speakerLabels);
        const index = speakers.indexOf(speaker);
        return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
    }

    function startEditingSpeaker(originalLabel: string) {
        setEditingSpeaker(originalLabel);
        setEditValue(speakerLabels[originalLabel] || originalLabel);
    }

    async function saveSpeakerLabel(originalLabel: string) {
        if (!editValue.trim()) {
            setEditingSpeaker(null);
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/meetings/${id}/speakers`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    originalLabel,
                    customLabel: editValue.trim(),
                }),
            });

            if (!res.ok) throw new Error('Failed to update speaker label');

            // Update local state
            setSpeakerLabels((prev) => ({
                ...prev,
                [originalLabel]: editValue.trim(),
            }));
        } catch (err) {
            console.error('Failed to save speaker label:', err);
        } finally {
            setEditingSpeaker(null);
        }
    }

    if (loading) return <div className="loading">Loading transcript...</div>;

    const showTranscript = meeting?.transcription_status === 'completed' && transcript.length > 0;

    return (
        <div className="transcript-view-container">
            <header>
                <Link to="/" className="back-link">← Back to meetings</Link>
                <h1>{meeting?.title || 'Meeting Transcript'}</h1>
            </header>

            {meeting && <BotStatusBanner meetingId={meeting.meeting_id} status={meeting.transcription_status} />}

            {error && <div className="error">{error}</div>}

            {!showTranscript && meeting && (
                <div className="transcript-status">
                    <p>Transcript status: {meeting.transcription_status}</p>
                    {meeting.transcription_status === 'processing' && (
                        <p>Your transcript is being processed. This page will update automatically.</p>
                    )}
                </div>
            )}

            {showTranscript && (
                <div className="transcript-entries">
                    {transcript.map((entry, index) => (
                        <div key={index} className="transcript-entry">
                            <div
                                className="speaker-label"
                                style={{ color: getSpeakerColor(entry.speaker) }}
                            >
                                {editingSpeaker === entry.speaker ? (
                                    <input
                                        type="text"
                                        value={editValue}
                                        onChange={(e) => setEditValue(e.target.value)}
                                        onBlur={() => saveSpeakerLabel(entry.speaker)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') saveSpeakerLabel(entry.speaker);
                                            if (e.key === 'Escape') setEditingSpeaker(null);
                                        }}
                                        autoFocus
                                        aria-label="Edit speaker name"
                                    />
                                ) : (
                                    <span
                                        onClick={() => startEditingSpeaker(entry.speaker)}
                                        title="Click to rename speaker"
                                        role="button"
                                        tabIndex={0}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') startEditingSpeaker(entry.speaker);
                                        }}
                                    >
                                        {speakerLabels[entry.speaker] || entry.speaker}
                                    </span>
                                )}
                            </div>
                            <div className="entry-text">{entry.text}</div>
                            <div className="entry-timestamp">
                                {new Date(entry.timestamp).toLocaleTimeString()}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
