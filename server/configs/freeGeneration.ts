import './env.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import axios from 'axios';
import { cloudinary } from './cloudinary.js';

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';

/** Models that require enter.pollinations.ai (not the public image API). */
const POLLINATIONS_ENTER_ONLY_MODELS = new Set(['kontext']);

const getAspectDimensions = (aspectRatio?: string) => {
    if (aspectRatio === '16:9') {
        return { width: 1344, height: 768 };
    }
    return { width: 768, height: 1344 };
};

const extractCloudinaryPublicId = (secureUrl: string) => {
    const match = secureUrl.match(/\/upload\/(?:v\d+\/)?(.+?)\.[^/?]+(?:\?|$)/);
    if (!match?.[1]) {
        throw new Error('Could not parse Cloudinary public id from image URL');
    }
    return match[1];
};

/** Overlay product on model using Cloudinary transforms (no extra API cost). */
export const buildUgcCompositeUrl = (productUrl: string, modelUrl: string, aspectRatio?: string) => {
    const { width, height } = getAspectDimensions(aspectRatio);
    const modelId = extractCloudinaryPublicId(modelUrl);
    const productId = extractCloudinaryPublicId(productUrl);

    return cloudinary.url(modelId, {
        transformation: [
            {
                overlay: productId,
                width: Math.round(width * 0.38),
                crop: 'fit',
                gravity: 'south_east',
                x: 24,
                y: 24,
            },
            { width, height, crop: 'fill', gravity: 'center' },
        ],
        secure: true,
    });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parsePollinationsErrorBody = (data: unknown) => {
    if (!data) return null;
    if (Buffer.isBuffer(data)) {
        try {
            const parsed = JSON.parse(data.toString('utf8'));
            return parsed?.message || parsed?.error || null;
        } catch {
            return null;
        }
    }
    if (typeof data === 'object' && data !== null) {
        const obj = data as { message?: string; error?: string };
        return obj.message || obj.error || null;
    }
    return typeof data === 'string' ? data : null;
};

/** Public image.pollinations.ai supports flux/turbo/gptimage with optional `image` input. */
export const resolvePollinationsImageModel = () => {
    const requested = (process.env.POLLINATIONS_IMAGE_MODEL || 'flux').trim().toLowerCase();
    const hasEnterKey = Boolean(
        process.env.POLLINATIONS_ENTER_API_KEY?.trim() || process.env.POLLINATIONS_API_KEY?.trim()
    );

    if (POLLINATIONS_ENTER_ONLY_MODELS.has(requested) && !hasEnterKey) {
        console.warn(
            `[pollinations] Model "${requested}" requires enter.pollinations.ai. Falling back to "flux" on the free API.`
        );
        return 'flux';
    }

    return requested;
};

export const generateImageWithPollinations = async (
    compositeImageUrl: string,
    prompt: string,
    aspectRatio?: string
) => {
    const { width, height } = getAspectDimensions(aspectRatio);
    const model = resolvePollinationsImageModel();
    const params = new URLSearchParams({
        model,
        width: String(width),
        height: String(height),
        image: compositeImageUrl,
        nologo: process.env.POLLINATIONS_NO_LOGO || 'true',
        enhance: process.env.POLLINATIONS_ENHANCE || 'false',
        private: 'true',
    });

    if (process.env.POLLINATIONS_API_KEY) {
        params.set('key', process.env.POLLINATIONS_API_KEY);
    }

    const url = `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}?${params.toString()}`;
    const maxAttempts = Number(process.env.POLLINATIONS_MAX_ATTEMPTS || 3);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: Number(process.env.POLLINATIONS_TIMEOUT_MS || 180000),
            validateStatus: () => true,
        });

        if (response.status === 200 && (response.headers['content-type'] || '').includes('image')) {
            const contentType = response.headers['content-type'] || 'image/jpeg';
            const base64 = Buffer.from(response.data).toString('base64');
            return `data:${contentType};base64,${base64}`;
        }

        const apiMessage = parsePollinationsErrorBody(response.data);
        const err = new Error(apiMessage || `Pollinations returned HTTP ${response.status}`) as Error & {
            response?: { status: number; data: unknown };
        };
        err.response = { status: response.status, data: response.data };

        if (response.status === 429 && attempt < maxAttempts) {
            await sleep(Number(process.env.POLLINATIONS_RATE_LIMIT_WAIT_MS || 16000));
            continue;
        }

        throw err;
    }

    throw new Error('Pollinations image generation failed');
};

export const generateImageWithHuggingFace = async (
    compositeImageUrl: string,
    prompt: string,
    aspectRatio?: string
) => {
    const token = process.env.HF_TOKEN?.trim();
    if (!token) {
        throw new Error('HF_TOKEN is not configured');
    }

    const { width, height } = getAspectDimensions(aspectRatio);
    const model = process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-Kontext-dev';

    const imageResponse = await axios.get(compositeImageUrl, { responseType: 'arraybuffer' });
    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');

    const response = await axios.post(
        `https://api-inference.huggingface.co/models/${model}`,
        {
            inputs: imageBase64,
            parameters: {
                prompt,
                width,
                height,
                num_inference_steps: Number(process.env.HF_IMAGE_STEPS || 28),
            },
        },
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'image/png',
            },
            responseType: 'arraybuffer',
            timeout: Number(process.env.HF_IMAGE_TIMEOUT_MS || 180000),
        }
    );

    const mimeType = response.headers['content-type'] || 'image/png';
    return `data:${mimeType};base64,${Buffer.from(response.data).toString('base64')}`;
};

export const downloadImageToTemp = async (imageUrl: string) => {
    const tempDir = path.join(os.tmpdir(), 'ugc-images');
    fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `frame-${Date.now()}.jpg`);

    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(filePath, Buffer.from(response.data));
    return filePath;
};

const runFfmpeg = (ffmpegPath: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegPath, args, { windowsHide: true });
        let stderr = '';

        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            const tail = stderr.trim().slice(-600);
            reject(new Error(tail || `FFmpeg exited with code ${code}`));
        });
    });

/** Builds a short MP4 from a still image (Ken Burns-style motion via slow zoom). */
export const generateVideoWithFfmpeg = async ({
    imageUrl,
    durationSec,
    aspectRatio,
}: {
    imageUrl: string;
    durationSec?: number;
    aspectRatio?: string;
}) => {
    const ffmpegStatic = await import('ffmpeg-static');
    const ffmpegPath = ffmpegStatic.default;

    if (!ffmpegPath) {
        throw new Error('FFmpeg binary not found. Install ffmpeg-static or FFmpeg on your system.');
    }

    const duration = Math.min(Math.max(Number(durationSec) || 5, 3), 15);
    const fps = 24;
    const frames = duration * fps;
    const [width, height] = aspectRatio === '16:9' ? [1280, 720] : [720, 1280];
    const size = `${width}x${height}`;
    const cropSize = `${width}:${height}`;
    const tempDir = path.join(os.tmpdir(), 'ugc-videos');
    fs.mkdirSync(tempDir, { recursive: true });
    const outputPath = path.join(tempDir, `ugc-${Date.now()}.mp4`);

    const imagePath = await downloadImageToTemp(imageUrl);

    try {
        const vf = [
            `scale=${cropSize}:force_original_aspect_ratio=increase`,
            `crop=${cropSize}`,
            `zoompan=z='min(zoom+0.0008,1.08)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}`,
        ].join(',');

        await runFfmpeg(ffmpegPath, [
            '-y',
            '-loop',
            '1',
            '-i',
            imagePath,
            '-vf',
            vf,
            '-t',
            String(duration),
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            '-an',
            '-r',
            String(fps),
            outputPath,
        ]);

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
            throw new Error('FFmpeg produced an empty or invalid video file');
        }

        return outputPath;
    } finally {
        if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
        }
    }
};
