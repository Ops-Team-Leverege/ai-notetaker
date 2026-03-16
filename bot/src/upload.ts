/**
 * Audio upload to Cloud Storage with retry logic.
 */

import { Storage } from '@google-cloud/storage';
import * as crypto from 'crypto';

const storage = new Storage();
const AUDIO_BUCKET = process.env.AUDIO_BUCKET || 'leverege-notetaker-audio';
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

export interface UploadOptions {
    meetingId: string;
    owningUser: string;
    audioData: string; // base64 data URL
}

/**
 * Upload audio to Cloud Storage with retry and exponential backoff.
 */
export async function uploadAudio(options: UploadOptions): Promise<string> {
    const { meetingId, owningUser, audioData } = options;

    // Hash owning user for path
    const userHash = crypto.createHash('sha256').update(owningUser).digest('hex').slice(0, 16);
    const blobPath = `${userHash}/${meetingId}/audio.wav`;

    // Convert base64 data URL to buffer
    const base64Data = audioData.split(',')[1] || audioData;
    const buffer = Buffer.from(base64Data, 'base64');

    const bucket = storage.bucket(AUDIO_BUCKET);
    const blob = bucket.file(blobPath);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            await blob.save(buffer, {
                contentType: 'audio/wav',
                metadata: {
                    meeting_id: meetingId,
                    owning_user: owningUser,
                },
            });

            console.log(`Uploaded audio to gs://${AUDIO_BUCKET}/${blobPath}`);
            return `gs://${AUDIO_BUCKET}/${blobPath}`;
        } catch (err) {
            console.error(`Upload attempt ${attempt + 1}/${MAX_RETRIES} failed:`, err);

            if (attempt < MAX_RETRIES - 1) {
                const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    throw new Error(`Failed to upload audio after ${MAX_RETRIES} attempts`);
}
