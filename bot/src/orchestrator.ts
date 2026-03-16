/**
 * Bot Orchestrator - manages bot lifecycle for meeting recordings.
 */

import { EventEmitter } from 'events';
import { BotSession, BotSessionStatus, Platform } from './types';
import { MeetingBot } from './bot';

const sessions = new Map<string, BotSession>();
const bots = new Map<string, MeetingBot>();
const statusEmitters = new Map<string, EventEmitter>();

export interface DispatchOptions {
    meetingId: string;
    meetingUrl: string;
    platform: Platform;
    owningUser: string;
}

/**
 * Dispatch a bot to join a meeting and start recording.
 */
export async function dispatchBot(options: DispatchOptions): Promise<BotSession> {
    const { meetingId, meetingUrl, platform, owningUser } = options;

    // Check if session already exists
    if (sessions.has(meetingId)) {
        return sessions.get(meetingId)!;
    }

    const session: BotSession = {
        meetingId,
        status: 'joining',
        startedAt: new Date(),
        platform,
    };

    sessions.set(meetingId, session);

    // Create status emitter for SSE
    const emitter = new EventEmitter();
    statusEmitters.set(meetingId, emitter);

    // Create and start bot
    const bot = new MeetingBot({
        meetingId,
        meetingUrl,
        platform,
        owningUser,
        onStatusChange: (status) => {
            updateStatus(meetingId, status);
        },
    });

    bots.set(meetingId, bot);

    // Start bot asynchronously
    bot.start().catch((err) => {
        console.error(`Bot failed for meeting ${meetingId}:`, err);
        updateStatus(meetingId, 'failed');
    });

    return session;
}

/**
 * Get current bot status for a meeting.
 */
export function getBotStatus(meetingId: string): BotSession | null {
    return sessions.get(meetingId) || null;
}

/**
 * Stop a bot and finalize capture.
 */
export async function stopBot(meetingId: string): Promise<void> {
    const bot = bots.get(meetingId);
    if (bot) {
        await bot.stop();
        bots.delete(meetingId);
    }
}


/**
 * Subscribe to bot status updates via SSE.
 */
export function streamStatus(meetingId: string, callback: (status: BotSessionStatus) => void): () => void {
    const emitter = statusEmitters.get(meetingId);
    if (!emitter) {
        return () => { };
    }

    const handler = (status: BotSessionStatus) => callback(status);
    emitter.on('status', handler);

    // Return unsubscribe function
    return () => {
        emitter.off('status', handler);
    };
}

/**
 * Update session status and emit to subscribers.
 */
function updateStatus(meetingId: string, status: BotSessionStatus): void {
    const session = sessions.get(meetingId);
    if (session) {
        session.status = status;
    }

    const emitter = statusEmitters.get(meetingId);
    if (emitter) {
        emitter.emit('status', status);
    }

    // Cleanup on terminal states
    if (status === 'completed' || status === 'failed') {
        setTimeout(() => {
            sessions.delete(meetingId);
            statusEmitters.delete(meetingId);
            bots.delete(meetingId);
        }, 60000); // Keep for 1 minute for late subscribers
    }
}

/**
 * Get all active sessions.
 */
export function getActiveSessions(): BotSession[] {
    return Array.from(sessions.values());
}
