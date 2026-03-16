import React, { useState, useEffect, useRef } from 'react';

interface Props {
    meetingId: string;
    status: string;
}

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const STATUS_MESSAGES: Record<string, string> = {
    pending: 'Waiting to start...',
    joining: 'Bot is joining the meeting...',
    waiting_room: 'Bot is in the waiting room. Please admit the notetaker.',
    in_meeting: 'Bot is in the meeting',
    capturing: 'Recording audio...',
    uploading: 'Uploading recording...',
    transcription_pending: 'Queued for transcription',
    processing: 'Transcribing...',
    completed: 'Transcript ready',
    failed: 'Transcription failed',
    transcription_failed: 'Transcription failed',
};

export function BotStatusBanner({ meetingId, status: initialStatus }: Props) {
    const [status, setStatus] = useState(initialStatus);
    const eventSourceRef = useRef<EventSource | null>(null);

    useEffect(() => {
        // Only subscribe to SSE for active statuses
        const activeStatuses = ['pending', 'joining', 'waiting_room', 'in_meeting', 'capturing', 'uploading', 'processing'];
        if (!activeStatuses.includes(status)) {
            return;
        }

        // Connect to SSE stream
        const url = `${API_BASE}/meetings/${meetingId}/status`;
        const eventSource = new EventSource(url, { withCredentials: true });
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.status) {
                    setStatus(data.status);
                }
            } catch {
                // Ignore parse errors
            }
        };

        eventSource.onerror = () => {
            // Reconnect handled by browser, or close if terminal status
            if (!activeStatuses.includes(status)) {
                eventSource.close();
            }
        };

        return () => {
            eventSource.close();
        };
    }, [meetingId, status]);

    // Update status when prop changes
    useEffect(() => {
        setStatus(initialStatus);
    }, [initialStatus]);

    const message = STATUS_MESSAGES[status] || status;
    const isWaitingRoom = status === 'waiting_room';
    const isActive = ['pending', 'joining', 'waiting_room', 'in_meeting', 'capturing', 'uploading', 'processing', 'transcription_pending'].includes(status);
    const isFailed = status === 'failed' || status === 'transcription_failed';

    if (status === 'completed') {
        return null; // Don't show banner when complete
    }

    return (
        <div
            className={`bot-status-banner ${isWaitingRoom ? 'waiting-room' : ''} ${isFailed ? 'failed' : ''}`}
            role="status"
            aria-live="polite"
        >
            {isActive && <span className="status-indicator" />}
            <span className="status-message">{message}</span>
            {isWaitingRoom && (
                <span className="waiting-room-hint">
                    Look for "Notetaker" in your meeting's waiting room
                </span>
            )}
        </div>
    );
}
