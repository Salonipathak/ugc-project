import './env.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import { getGoogleAI } from './ai.js';
import { getAxiosErrorMessage } from '../utils/httpErrors.js';

const OPENROUTER_API_BASE = process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1';
const OPENROUTER_POLL_INTERVAL_MS = Number(process.env.OPENROUTER_VIDEO_POLL_INTERVAL_MS || 5000);
const OPENROUTER_POLL_TIMEOUT_MS = Number(process.env.OPENROUTER_VIDEO_POLL_TIMEOUT_MS || 600000);

export const buildVideoGenerationPrompt = ({
    productName,
    productDescription,
    userPrompt,
    aspectRatio,
}: {
    productName: string;
    productDescription?: string;
    userPrompt?: string;
    aspectRatio?: string;
}) => {
    return `Create a short, realistic UGC-style product video from this image.
The person should naturally present and use ${productName}.
Keep the product and person visually consistent with the source image.
Use smooth camera motion and authentic social-media ad pacing.
Aspect ratio: ${aspectRatio || '9:16'}.
${productDescription ? `Product context: ${productDescription}.` : ''}
${userPrompt ? `Creative direction: ${userPrompt}` : ''}`;
};

const openRouterHeaders = () => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

    return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:5000',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'UGC Project',
    };
};

const formatVideoProviderError = (provider: string, error: any) => {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const nestedError = data?.error as { message?: string } | string | undefined;
    const apiMessage =
        data?.message ||
        data?.error ||
        (typeof nestedError === 'string' ? nestedError : nestedError?.message) ||
        (typeof data === 'string' ? data : null);

    if (apiMessage) {
        if (provider === 'OpenRouter' && status === 402) {
            return `${provider}: insufficient credits — add billing at https://openrouter.ai/credits`;
        }
        return `${provider}: ${status ? `[${status}] ` : ''}${apiMessage}`;
    }

    return `${provider}: ${error?.message || 'failed'}`;
};

const guessMimeTypeFromUrl = (url: string) => {
    const lower = url.split('?')[0].toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
};

const clampDuration = (targetLength?: number) => {
    const seconds = Number(targetLength) || 5;
    return Math.min(Math.max(seconds, 4), 8);
};

const waitForOpenRouterVideo = async (jobId: string) => {
    const headers = openRouterHeaders();
    const startedAt = Date.now();

    while (Date.now() - startedAt < OPENROUTER_POLL_TIMEOUT_MS) {
        const { data } = await axios.get(`${OPENROUTER_API_BASE}/videos/${jobId}`, { headers });
        const status = data?.status as string | undefined;

        if (status === 'completed') {
            return jobId;
        }

        if (status === 'failed' || status === 'cancelled' || status === 'expired') {
            throw new Error(data?.error || `OpenRouter video generation ${status}`);
        }

        await new Promise((resolve) => setTimeout(resolve, OPENROUTER_POLL_INTERVAL_MS));
    }

    throw new Error('OpenRouter video generation timed out');
};

const downloadOpenRouterVideo = async (jobId: string) => {
    const headers = openRouterHeaders();
    const tempDir = path.join(os.tmpdir(), 'ugc-videos');
    fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `openrouter-${jobId}-${Date.now()}.mp4`);

    const response = await axios.get(`${OPENROUTER_API_BASE}/videos/${jobId}/content`, {
        headers,
        params: { index: 0 },
        responseType: 'arraybuffer',
        timeout: Number(process.env.OPENROUTER_VIDEO_DOWNLOAD_TIMEOUT_MS || 120000),
    });

    fs.writeFileSync(filePath, Buffer.from(response.data));
    return filePath;
};

export const generateVideoWithOpenRouter = async ({
    imageUrl,
    prompt,
    aspectRatio,
    targetLength,
}: {
    imageUrl: string;
    prompt: string;
    aspectRatio?: string;
    targetLength?: number;
}) => {
    const aspect = aspectRatio === '16:9' ? '16:9' : '9:16';
    const model = process.env.OPENROUTER_VIDEO_MODEL || 'google/veo-3.1-lite';

    let data: { id?: string };
    try {
        const response = await axios.post(
            `${OPENROUTER_API_BASE}/videos`,
            {
                model,
                prompt,
                duration: clampDuration(targetLength),
                resolution: process.env.OPENROUTER_VIDEO_RESOLUTION || '720p',
                aspect_ratio: aspect,
                generate_audio: process.env.OPENROUTER_VIDEO_AUDIO === 'true',
                frame_images: [
                    {
                        type: 'image_url',
                        image_url: { url: imageUrl },
                        frame_type: 'first_frame',
                    },
                ],
            },
            { headers: openRouterHeaders(), timeout: 60000 }
        );
        data = response.data;
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 401 || status === 403) {
            throw new Error(
                'OpenRouter rejected your API key (401). Create a new key at https://openrouter.ai/keys and update OPENROUTER_API_KEY in server/.env'
            );
        }
        const apiMessage = getAxiosErrorMessage(error, '');
        if (
            status === 402 ||
            /requires more credits|can only afford|insufficient credits/i.test(apiMessage)
        ) {
            throw new Error(
                `OpenRouter credits too low for video generation. Add credits at https://openrouter.ai/settings/credits. (${apiMessage})`
            );
        }
        throw new Error(apiMessage || 'OpenRouter video generation failed');
    }

    const jobId = data?.id;
    if (!jobId) {
        throw new Error('OpenRouter did not create a video generation job');
    }

    await waitForOpenRouterVideo(jobId);
    return downloadOpenRouterVideo(jobId);
};

export const generateVideoWithGoogle = async ({
    imageUrl,
    prompt,
    aspectRatio,
    userId,
}: {
    imageUrl: string;
    prompt: string;
    aspectRatio?: string;
    userId: string;
}) => {
    const apiKey = process.env.GOOGLE_CLOUD_API_KEY?.trim();
    if (!apiKey) {
        throw new Error('GOOGLE_CLOUD_API_KEY is not configured');
    }

    const model = process.env.GOOGLE_VIDEO_MODEL || 'veo-3.1-generate-preview';
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBytes = Buffer.from(imageResponse.data);

    const ai = getGoogleAI();
    let operation: any = await ai.models.generateVideos({
        model,
        prompt,
        image: {
            imageBytes: imageBytes.toString('base64'),
            mimeType: guessMimeTypeFromUrl(imageUrl),
        },
        config: {
            aspectRatio: aspectRatio === '16:9' ? '16:9' : '9:16',
            numberOfVideos: 1,
            resolution: process.env.GOOGLE_VIDEO_RESOLUTION || '720p',
        },
    });

    const pollMs = Number(process.env.GOOGLE_VIDEO_POLL_INTERVAL_MS || 10000);
    const timeoutMs = Number(process.env.GOOGLE_VIDEO_POLL_TIMEOUT_MS || 600000);
    const startedAt = Date.now();

    while (!operation.done) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Google video generation timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        operation = await ai.operations.getVideosOperation({ operation });
    }

    if (!operation.response?.generatedVideos?.length) {
        const filterReason =
            operation.response?.raiMediaFilteredReasons?.[0] || 'Video generation failed';
        throw new Error(filterReason);
    }

    const videosDir = path.join(process.cwd(), 'videos');
    fs.mkdirSync(videosDir, { recursive: true });
    const filePath = path.join(videosDir, `${userId}-${Date.now()}.mp4`);

    await ai.files.download({
        file: operation.response.generatedVideos[0].video,
        downloadPath: filePath,
    });

    return filePath;
};

export const generateProjectVideo = async ({
    imageUrl,
    prompt,
    aspectRatio,
    targetLength,
    userId,
}: {
    imageUrl: string;
    prompt: string;
    aspectRatio?: string;
    targetLength?: number;
    userId: string;
}) => {
    const configured =
        process.env.VIDEO_GENERATION_PROVIDER?.trim().toLowerCase() ||
        (process.env.OPENROUTER_API_KEY?.trim() ? 'openrouter' : '');

    if (configured === 'openrouter') {
        if (!process.env.OPENROUTER_API_KEY?.trim()) {
            throw new Error('OPENROUTER_API_KEY is not configured in server/.env');
        }
        return generateVideoWithOpenRouter({ imageUrl, prompt, aspectRatio, targetLength });
    }

    throw new Error(
        `Unsupported VIDEO_GENERATION_PROVIDER="${configured}". Set VIDEO_GENERATION_PROVIDER=openrouter and OPENROUTER_API_KEY in server/.env`
    );
};
