/**
 * Bot Dispatch Service — spins up Compute Engine VMs to run meeting bots.
 *
 * Dispatches the correct bot container based on platform:
 *   - zoom → zoom-bot container on e2-standard-2 VM
 *   - google_meet → playwright bot container on e2-standard-2 VM
 *   - teams → placeholder (not yet implemented)
 *
 * VMs are preemptible, terminate when the bot process exits.
 */

import { getPool } from '../db';
import { Platform } from '../types';

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'ai-meeting-notetaker-490206';
const REGION = process.env.GCP_REGION || 'us-central1';
const ZONE = process.env.GCP_ZONE || 'us-central1-a';
const API_URL = process.env.API_URL || '';
const AUDIO_BUCKET = process.env.AUDIO_BUCKET || 'leverege-notetaker-audio';
const TRANSCRIPTION_QUEUE = process.env.TRANSCRIPTION_QUEUE || 'transcription-queue';
const TRANSCRIPTION_WORKER_URL = process.env.TRANSCRIPTION_WORKER_URL || '';
const CONTAINER_REGISTRY = `${REGION}-docker.pkg.dev/${PROJECT_ID}/notetaker`;

interface DispatchResult {
    dispatched: boolean;
    vmName?: string;
    error?: string;
}

/**
 * Parse a Zoom meeting URL to extract meeting number and passcode.
 */
export function parseZoomUrl(meetingLink: string): { meetingNumber: string; passcode: string } {
    const url = new URL(meetingLink);
    const pathMatch = url.pathname.match(/\/j\/(\d+)/);
    const meetingNumber = pathMatch ? pathMatch[1] : '';
    const passcode = url.searchParams.get('pwd') || '';
    return { meetingNumber, passcode };
}

/**
 * Update meeting status in Cloud SQL.
 */
export async function updateMeetingStatus(
    meetingId: string,
    status: string,
    errorMessage?: string,
): Promise<void> {
    const pool = getPool();
    if (errorMessage) {
        await pool.query(
            `UPDATE meetings SET transcription_status = $1, updated_at = NOW() WHERE meeting_id = $2`,
            [status, meetingId],
        );
    } else {
        await pool.query(
            `UPDATE meetings SET transcription_status = $1, updated_at = NOW() WHERE meeting_id = $2`,
            [status, meetingId],
        );
    }
}

/**
 * Create a preemptible Compute Engine VM to run a bot container.
 * The VM auto-deletes when the container exits.
 */
async function createBotVm(
    vmName: string,
    containerImage: string,
    envVars: Record<string, string>,
): Promise<string> {
    const { InstancesClient } = await import('@google-cloud/compute');
    const client = new InstancesClient();

    // Build metadata for container-optimized OS
    const envString = Object.entries(envVars)
        .map(([k, v]) => `      - name: ${k}\n        value: "${v}"`)
        .join('\n');

    const containerSpec = `
spec:
  containers:
    - name: bot
      image: ${containerImage}
      env:
${envString}
      stdin: false
      tty: false
  restartPolicy: Never
`;

    const [operation] = await client.insert({
        project: PROJECT_ID,
        zone: ZONE,
        instanceResource: {
            name: vmName,
            machineType: `zones/${ZONE}/machineTypes/e2-standard-2`,
            scheduling: {
                preemptible: true,
                automaticRestart: false,
            },
            disks: [
                {
                    boot: true,
                    autoDelete: true,
                    initializeParams: {
                        sourceImage:
                            'projects/cos-cloud/global/images/family/cos-stable',
                        diskSizeGb: '30',
                    },
                },
            ],
            networkInterfaces: [
                {
                    network: `projects/${PROJECT_ID}/global/networks/default`,
                    accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }],
                },
            ],
            serviceAccounts: [
                {
                    email: 'default',
                    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
                },
            ],
            metadata: {
                items: [
                    {
                        key: 'gce-container-declaration',
                        value: containerSpec,
                    },
                    {
                        key: 'google-logging-enabled',
                        value: 'true',
                    },
                ],
            },
            labels: {
                purpose: 'meeting-bot',
            },
        },
    });

    // Log the operation result — the LROperation metadata contains the GCE operation details
    const opMeta = operation.metadata as Record<string, any> | undefined;
    console.log(`[botDispatch] VM insert operation: name=${operation.name} metadata=${JSON.stringify({
        status: opMeta?.status,
        targetLink: opMeta?.targetLink,
        error: opMeta?.error,
    })}`);
    if (opMeta?.error) {
        const errors = opMeta.error.errors?.map((e: any) => e.message || e.code).join(', ') || 'unknown';
        throw new Error(`VM creation operation failed: ${errors}`);
    }

    console.log(`[botDispatch] VM ${vmName} insert accepted (operation=${operation.name})`);
    return vmName;
}

interface DispatchOptions {
    meetingId: string;
    meetingLink: string;
    platform: Platform;
    owningUser: string;
    passcode?: string;
    botName?: string;
}

/**
 * Dispatch a bot for the given meeting.
 * Called after createMeeting() inserts the record.
 */
export async function dispatchBot(opts: DispatchOptions): Promise<DispatchResult> {
    const { meetingId, meetingLink, platform, owningUser, botName } = opts;
    const timestamp = Date.now();
    const displayName = botName || 'Leverege Notetaker';

    try {
        switch (platform) {
            case 'zoom': {
                const { meetingNumber, passcode: urlPasscode } = parseZoomUrl(meetingLink);
                // Prefer explicitly provided passcode over URL-extracted one
                const passcode = opts.passcode || urlPasscode;
                if (!meetingNumber) {
                    await updateMeetingStatus(meetingId, 'transcription_failed');
                    return { dispatched: false, error: 'Could not parse Zoom meeting number from URL' };
                }

                const vmName = `zoom-bot-${meetingId.slice(0, 8)}-${timestamp}`;
                console.log(`[botDispatch] Creating VM ${vmName} for Zoom meeting ${meetingId}`);
                await createBotVm(vmName, `${CONTAINER_REGISTRY}/zoom-bot:latest`, {
                    BOT_MEETING_ID: meetingId,
                    BOT_MEETING_NUMBER: meetingNumber,
                    BOT_PASSCODE: passcode,
                    BOT_DISPLAY_NAME: displayName,
                    BOT_OWNING_USER: owningUser,
                    GCP_PROJECT_ID: PROJECT_ID,
                    GCP_REGION: REGION,
                    AUDIO_BUCKET: AUDIO_BUCKET,
                    TRANSCRIPTION_QUEUE: TRANSCRIPTION_QUEUE,
                    TRANSCRIPTION_WORKER_URL: TRANSCRIPTION_WORKER_URL,
                });

                await updateMeetingStatus(meetingId, 'processing');
                return { dispatched: true, vmName };
            }

            case 'google_meet': {
                const vmName = `meet-bot-${meetingId.slice(0, 8)}-${timestamp}`;
                console.log(`[botDispatch] Creating VM ${vmName} for Google Meet meeting ${meetingId}`);
                await createBotVm(vmName, `${CONTAINER_REGISTRY}/bot:latest`, {
                    BOT_MEETING_ID: meetingId,
                    BOT_MEETING_LINK: meetingLink,
                    BOT_DISPLAY_NAME: displayName,
                    BOT_OWNING_USER: owningUser,
                    GCP_PROJECT_ID: PROJECT_ID,
                    GCP_REGION: REGION,
                });

                await updateMeetingStatus(meetingId, 'processing');
                return { dispatched: true, vmName };
            }

            case 'teams': {
                await updateMeetingStatus(meetingId, 'transcription_failed');
                return { dispatched: false, error: 'Teams bot coming soon' };
            }

            default:
                return { dispatched: false, error: `Unknown platform: ${platform}` };
        }
    } catch (err: any) {
        console.error(`[botDispatch] Failed to dispatch bot for meeting ${meetingId}:`, err.message || err);
        console.error(`[botDispatch] Error details:`, JSON.stringify({
            code: err.code,
            status: err.status,
            statusCode: err.statusCode,
            details: err.details,
            errors: err.errors,
            stack: err.stack?.split('\n').slice(0, 5),
        }, null, 2));
        try {
            await updateMeetingStatus(meetingId, 'transcription_failed');
        } catch (statusErr: any) {
            console.error(`[botDispatch] Also failed to update status:`, statusErr.message);
        }
        return { dispatched: false, error: err.message || 'VM creation failed' };
    }
}
