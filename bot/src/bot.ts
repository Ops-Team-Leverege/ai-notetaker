/**
 * MeetingBot - Playwright-based bot for joining meetings and capturing audio.
 */

import { chromium, Browser, Page } from 'playwright';
import { Platform, BotSessionStatus } from './types';
import { uploadAudio } from './upload';
import { getCredentials } from './credentials';

const JOIN_TIMEOUT_MS = 60_000; // 60 seconds
const WAITING_ROOM_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export interface BotOptions {
    meetingId: string;
    meetingUrl: string;
    platform: Platform;
    owningUser: string;
    onStatusChange: (status: BotSessionStatus) => void;
}

export class MeetingBot {
    private options: BotOptions;
    private browser: Browser | null = null;
    private page: Page | null = null;
    private audioChunks: Buffer[] = [];
    private isCapturing = false;
    private stopped = false;

    constructor(options: BotOptions) {
        this.options = options;
    }

    async start(): Promise<void> {
        try {
            await this.join();
            await this.startCapture();
        } catch (err) {
            this.options.onStatusChange('failed');
            throw err;
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        await this.stopCapture();
        await this.leave();
    }

    /**
     * Join the meeting using Playwright.
     */
    async join(): Promise<void> {
        this.options.onStatusChange('joining');

        // Launch browser with flags for virtual audio capture
        this.browser = await chromium.launch({
            headless: true,
            args: [
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--autoplay-policy=no-user-gesture-required',
            ],
        });

        const context = await this.browser.newContext({
            permissions: ['microphone', 'camera'],
        });

        this.page = await context.newPage();

        // Get platform credentials
        const creds = await getCredentials(this.options.platform);

        // Navigate to meeting URL
        await this.page.goto(this.options.meetingUrl, { timeout: JOIN_TIMEOUT_MS });

        // Platform-specific join flow
        // Zoom and Teams use cloud recording webhooks — no Playwright bot needed.
        // The bot only joins Google Meet external meetings via Playwright.
        switch (this.options.platform) {
            case 'google_meet':
                await this.joinGoogleMeet(creds);
                break;
            case 'zoom':
            case 'teams':
                throw new Error(
                    `Platform "${this.options.platform}" uses cloud recording webhooks, not the Playwright bot`,
                );
        }
    }


    private async joinGoogleMeet(creds: Record<string, string>): Promise<void> {
        if (!this.page) return;

        // Sign in with Google account (notetaker@leverege.com)
        // Handle Google SSO flow
        try {
            // Click "Sign in" if present
            const signInBtn = this.page.locator('text=Sign in');
            if (await signInBtn.isVisible({ timeout: 5000 })) {
                await signInBtn.click();
                // Enter email
                await this.page.fill('input[type="email"]', creds.email || '');
                await this.page.click('text=Next');
                // Enter password
                await this.page.fill('input[type="password"]', creds.password || '');
                await this.page.click('text=Next');
                await this.page.waitForNavigation({ timeout: 30000 });
            }
        } catch {
            // May already be signed in or different flow
        }

        // Turn off camera and mic before joining
        try {
            await this.page.click('[aria-label*="camera"]', { timeout: 5000 });
            await this.page.click('[aria-label*="microphone"]', { timeout: 5000 });
        } catch {
            // Controls may not be visible
        }

        // Click "Join now" or "Ask to join"
        const joinBtn = this.page.locator('text=Join now, text=Ask to join').first();
        await joinBtn.click({ timeout: JOIN_TIMEOUT_MS });

        // Check for waiting room
        await this.handleWaitingRoom();

        this.options.onStatusChange('in_meeting');
    }

    private async handleWaitingRoom(): Promise<void> {
        if (!this.page) return;

        // Check for waiting room indicators
        const waitingIndicators = [
            'text=waiting room',
            'text=waiting for host',
            'text=lobby',
            'text=admit',
        ];

        for (const indicator of waitingIndicators) {
            try {
                const el = this.page.locator(indicator);
                if (await el.isVisible({ timeout: 2000 })) {
                    this.options.onStatusChange('waiting_room');

                    // Wait for admission or timeout
                    await this.page.waitForSelector(indicator, {
                        state: 'hidden',
                        timeout: WAITING_ROOM_TIMEOUT_MS,
                    });
                    return;
                }
            } catch {
                // Not in waiting room or timed out
            }
        }
    }


    /**
     * Start capturing audio using CDP MediaRecorder.
     */
    async startCapture(): Promise<void> {
        if (!this.page || this.isCapturing) return;

        this.options.onStatusChange('capturing');
        this.isCapturing = true;

        // Use CDP to capture audio from the page
        const client = await this.page.context().newCDPSession(this.page);

        // Inject audio capture script
        await this.page.evaluate(() => {
            // @ts-ignore
            window.__audioChunks = [];

            // Capture all audio elements
            const audioContext = new AudioContext({ sampleRate: 16000 });
            const destination = audioContext.createMediaStreamDestination();

            // Connect all audio/video elements to our destination
            document.querySelectorAll('audio, video').forEach((el) => {
                try {
                    // @ts-ignore
                    const source = audioContext.createMediaElementSource(el);
                    source.connect(destination);
                    source.connect(audioContext.destination); // Also play locally
                } catch {
                    // Element may already be connected
                }
            });

            // Start recording
            const recorder = new MediaRecorder(destination.stream, {
                mimeType: 'audio/webm',
            });

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    // @ts-ignore
                    window.__audioChunks.push(e.data);
                }
            };

            recorder.start(1000); // Capture in 1-second chunks
            // @ts-ignore
            window.__recorder = recorder;
        });
    }

    /**
     * Stop capturing and finalize audio buffer.
     */
    async stopCapture(): Promise<void> {
        if (!this.page || !this.isCapturing) return;

        this.options.onStatusChange('uploading');
        this.isCapturing = false;

        // Stop recorder and get chunks
        const audioData = await this.page.evaluate(async () => {
            // @ts-ignore
            const recorder = window.__recorder;
            if (recorder && recorder.state !== 'inactive') {
                recorder.stop();
            }

            // Wait for final data
            await new Promise((r) => setTimeout(r, 500));

            // @ts-ignore
            const chunks = window.__audioChunks || [];
            const blob = new Blob(chunks, { type: 'audio/webm' });

            // Convert to base64
            return new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.readAsDataURL(blob);
            });
        });

        // Upload audio
        if (audioData) {
            await uploadAudio({
                meetingId: this.options.meetingId,
                owningUser: this.options.owningUser,
                audioData,
            });
        }

        this.options.onStatusChange('completed');
    }

    /**
     * Leave the meeting and close browser.
     */
    async leave(): Promise<void> {
        if (this.page) {
            try {
                // Try to click leave button
                const leaveBtn = this.page.locator('[aria-label*="leave"], text=Leave, text=End').first();
                await leaveBtn.click({ timeout: 5000 });
            } catch {
                // May not find leave button
            }
        }

        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }
}
