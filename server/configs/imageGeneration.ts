import './env.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';
import { cloudinary } from './cloudinary.js';
import { getGoogleAI } from './ai.js';
import { getAxiosErrorMessage } from '../utils/httpErrors.js';
import {
    buildUgcCompositeUrl,
    generateImageWithPollinations,
} from './freeGeneration.js';

export class OpenRouterCreditError extends Error {
    readonly affordableTokens?: number;

    constructor(message: string, affordableTokens?: number) {
        super(message);
        this.name = 'OpenRouterCreditError';
        this.affordableTokens = affordableTokens;
    }
}

const isOpenRouterCreditMessage = (message: string) =>
    /requires more credits|can only afford|insufficient credits/i.test(message);

const parseAffordableTokens = (message: string) => {
    const match = message.match(/can only afford\s+(\d+)/i);
    if (!match) return undefined;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : undefined;
};
const TENSOR_ART_API_BASE = process.env.TENSOR_ART_API_BASE || 'https://ap-east-1.tensorart.cloud';
const TENSOR_ART_POLL_INTERVAL_MS = Number(process.env.TENSOR_ART_POLL_INTERVAL_MS || 5000);
const TENSOR_ART_POLL_TIMEOUT_MS = Number(process.env.TENSOR_ART_POLL_TIMEOUT_MS || 180000);

const DEFAULT_TENSOR_ART_WORKFLOW_CONFIG = {
    templateId: '1002579564481744204',
    productImageNodeId: '60',
    modelImageNodeId: '63',
    promptNodeId: '6',
};

export type TensorArtWorkflowConfig = {
    templateId?: string;
    productImageNodeId?: string;
    modelImageNodeId?: string;
    promptNodeId?: string;
    negativePromptNodeId?: string;
    widthNodeId?: string;
    heightNodeId?: string;
    aspectRatioNodeId?: string;
};

type TensorArtFieldAttr = {
    nodeId: string;
    fieldName: string;
    fieldValue: string | number;
};

export const buildPrompt = (productName: string, productDescription?: string, userPrompt?: string) => {
    return `Combine reference image 1, the product, with reference image 2, the person, into one realistic ecommerce lifestyle photo.
Make the person naturally hold or use the product.
Preserve the product identity, shape, colors, and visible details.
Preserve the person's likeness while matching lighting, shadows, scale, and perspective.
Use professional studio lighting and produce photorealistic, commercial-quality imagery.
Product name: ${productName}.
${productDescription ? `Product description: ${productDescription}.` : ''}
${userPrompt ? `Additional direction: ${userPrompt}` : ''}`;
};

export const getTensorArtWorkflowConfig = (body: Record<string, unknown>): TensorArtWorkflowConfig => ({
    templateId:
        (body.tensorArtTemplateId as string) ||
        process.env.TENSOR_ART_TEMPLATE_ID ||
        DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.templateId,
    productImageNodeId:
        (body.tensorArtProductImageNodeId as string) ||
        process.env.TENSOR_ART_PRODUCT_IMAGE_NODE_ID ||
        DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.productImageNodeId,
    modelImageNodeId:
        (body.tensorArtModelImageNodeId as string) ||
        process.env.TENSOR_ART_MODEL_IMAGE_NODE_ID ||
        DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.modelImageNodeId,
    promptNodeId:
        (body.tensorArtPromptNodeId as string) ||
        process.env.TENSOR_ART_PROMPT_NODE_ID ||
        DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.promptNodeId,
    negativePromptNodeId:
        (body.tensorArtNegativePromptNodeId as string) || process.env.TENSOR_ART_NEGATIVE_PROMPT_NODE_ID,
    widthNodeId: (body.tensorArtWidthNodeId as string) || process.env.TENSOR_ART_WIDTH_NODE_ID,
    heightNodeId: (body.tensorArtHeightNodeId as string) || process.env.TENSOR_ART_HEIGHT_NODE_ID,
    aspectRatioNodeId:
        (body.tensorArtAspectRatioNodeId as string) || process.env.TENSOR_ART_ASPECT_RATIO_NODE_ID,
});

const getTensorArtDimensions = (aspectRatio?: string) => {
    if (aspectRatio === '16:9') {
        return { width: 1344, height: 768 };
    }
    return { width: 768, height: 1344 };
};

const formatProviderError = (provider: string, error: any) => {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const nestedError = data?.error as { message?: string } | string | undefined;
    const apiMessage =
        data?.message ||
        (typeof nestedError === 'string' ? nestedError : nestedError?.message) ||
        data?.detail ||
        (typeof data === 'string' ? data : null);

    if (apiMessage) {
        if (provider === 'OpenRouter' && (status === 401 || status === 403)) {
            return `${provider}: invalid API key. Add OPENROUTER_API_KEY from https://openrouter.ai/keys`;
        }
        if (provider === 'TensorArt' && /template id .* not found/i.test(apiMessage)) {
            return `${provider}: workflow template not found. Update TENSOR_ART_TEMPLATE_ID in server/.env with a valid template ID from your TensorArt API dashboard.`;
        }
        if (provider === 'Google Gemini' && (status === 429 || /quota/i.test(apiMessage))) {
            return `${provider}: API quota exceeded for image models. Enable billing at https://ai.google.dev/ or wait and retry.`;
        }
        if (
            provider === 'Pollinations (free)' &&
            /kontext model is only available on enter\.pollinations\.ai/i.test(String(apiMessage))
        ) {
            return `${provider}: kontext requires enter.pollinations.ai. Set POLLINATIONS_IMAGE_MODEL=flux in server/.env (default) or add a Pollinations Enter API key.`;
        }
        return `${provider}: ${status ? `[${status}] ` : ''}${apiMessage}`;
    }

    const message = error?.message || 'failed';
    if (message.includes('402') || message.toLowerCase().includes('insufficient credit')) {
        return `${provider}: account has no credits`;
    }
    if (message.includes('429') || message.toLowerCase().includes('quota')) {
        return `${provider}: API quota exceeded`;
    }

    return `${provider}: ${message}`;
};

const guessMimeType = (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'image/jpeg';
};

const fileToGenerativePart = (filePath: string) => ({
    inlineData: {
        data: fs.readFileSync(filePath).toString('base64'),
        mimeType: guessMimeType(filePath),
    },
});

const fileToDataUrl = (filePath: string) => {
    const mimeType = guessMimeType(filePath);
    const base64 = fs.readFileSync(filePath).toString('base64');
    return `data:${mimeType};base64,${base64}`;
};

const OPENROUTER_API_BASE = process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1';

const extractOpenRouterImageUrl = (data: Record<string, unknown>) => {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const images = message?.images as Array<Record<string, unknown>> | undefined;

    for (const image of images || []) {
        const imageUrl = image.image_url as { url?: string } | undefined;
        if (imageUrl?.url) return imageUrl.url;

        const imageUrlSnake = image.imageUrl as { url?: string } | undefined;
        if (imageUrlSnake?.url) return imageUrlSnake.url;
    }

    const content = message?.content;
    if (typeof content === 'string' && content.startsWith('data:image')) {
        return content;
    }

    if (Array.isArray(content)) {
        for (const part of content as Array<Record<string, unknown>>) {
            const url =
                (part.image_url as { url?: string } | undefined)?.url ||
                (part.imageUrl as { url?: string } | undefined)?.url;
            if (url) return url;
        }
    }

    return '';
};

const createTensorArtClient = () => {
    const apiKey = process.env.TENSOR_ART_API_KEY?.trim();
    if (!apiKey) {
        throw new Error('TENSOR_ART_API_KEY is not configured');
    }

    return axios.create({
        baseURL: TENSOR_ART_API_BASE,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });
};

const uploadTensorArtResource = async (filePath: string) => {
    const tensorArt = createTensorArtClient();
    const { data } = await tensorArt.post('/v1/resource/image', { expireSec: 3600 });

    if (!data?.resourceId || !data?.putUrl) {
        throw new Error('TensorArt did not return a resource upload URL');
    }

    await axios.put(data.putUrl, fs.createReadStream(filePath), {
        headers: data.headers || { 'Content-Type': guessMimeType(filePath) },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

    return data.resourceId as string;
};

const addEnvField = (
    fieldAttrs: TensorArtFieldAttr[],
    nodeId: string | undefined,
    defaultFieldName: string,
    fieldValue: string | number,
    fieldName?: string
) => {
    if (!nodeId) return;
    fieldAttrs.push({
        nodeId,
        fieldName: fieldName || defaultFieldName,
        fieldValue,
    });
};

const buildTensorArtFields = (
    productResourceId: string,
    modelResourceId: string,
    prompt: string,
    aspectRatio: string | undefined,
    workflowConfig: TensorArtWorkflowConfig
) => {
    const fieldAttrs: TensorArtFieldAttr[] = [];
    const { width, height } = getTensorArtDimensions(aspectRatio);

    addEnvField(
        fieldAttrs,
        workflowConfig.productImageNodeId,
        process.env.TENSOR_ART_PRODUCT_IMAGE_FIELD_NAME || 'image',
        productResourceId
    );
    addEnvField(
        fieldAttrs,
        workflowConfig.modelImageNodeId,
        process.env.TENSOR_ART_MODEL_IMAGE_FIELD_NAME || 'image',
        modelResourceId
    );
    addEnvField(
        fieldAttrs,
        workflowConfig.promptNodeId,
        process.env.TENSOR_ART_PROMPT_FIELD_NAME || 'text',
        prompt
    );
    addEnvField(
        fieldAttrs,
        workflowConfig.negativePromptNodeId,
        process.env.TENSOR_ART_NEGATIVE_PROMPT_FIELD_NAME || 'text',
        'blurry, low quality, distorted hands, extra fingers, missing fingers, bad anatomy, duplicate person, watermark, logo, text artifacts'
    );
    addEnvField(
        fieldAttrs,
        workflowConfig.widthNodeId,
        process.env.TENSOR_ART_WIDTH_FIELD_NAME || 'width',
        width
    );
    addEnvField(
        fieldAttrs,
        workflowConfig.heightNodeId,
        process.env.TENSOR_ART_HEIGHT_FIELD_NAME || 'height',
        height
    );
    addEnvField(
        fieldAttrs,
        workflowConfig.aspectRatioNodeId,
        process.env.TENSOR_ART_ASPECT_RATIO_FIELD_NAME || 'text',
        aspectRatio || '9:16'
    );

    if (fieldAttrs.length < 3) {
        throw new Error(
            'TensorArt workflow fields are missing. Product image, model image, and prompt node IDs are required.'
        );
    }

    return { fieldAttrs };
};

const getTensorArtOutputUrl = (job: Record<string, unknown>) => {
    const successInfo = job?.successInfo as Record<string, unknown> | undefined;
    const successImages = successInfo?.images as Array<{ url?: string }> | undefined;
    if (successImages?.[0]?.url) return successImages[0].url;

    const runningInfo = job?.runningInfo as Record<string, unknown> | undefined;
    const finishNodes =
        (runningInfo?.workflowFinishItem as Record<string, unknown> | undefined)?.nodes ||
        (successInfo?.workflowFinishItem as Record<string, unknown> | undefined)?.nodes ||
        {};

    for (const node of Object.values(finishNodes) as Array<Record<string, unknown>>) {
        const outputUi = node?.outputUi as Record<string, unknown> | undefined;
        const images = outputUi?.images as Array<{ filename?: string }> | undefined;
        if (images?.[0]?.filename) return images[0].filename;
    }

    return '';
};

const waitForTensorArtJob = async (jobId: string) => {
    const tensorArt = createTensorArtClient();
    const startedAt = Date.now();

    while (Date.now() - startedAt < TENSOR_ART_POLL_TIMEOUT_MS) {
        const { data } = await tensorArt.get(`/v1/jobs/${jobId}`);
        const job = data?.job as Record<string, unknown> | undefined;
        const status = job?.status as string | undefined;

        if (status === 'SUCCESS') {
            const outputUrl = getTensorArtOutputUrl(job || {});
            if (!outputUrl) {
                throw new Error('TensorArt completed without returning an image URL');
            }
            return outputUrl;
        }

        if (status === 'FAILED' || status === 'CANCELED') {
            const failedInfo = job?.failedInfo as { reason?: string } | undefined;
            throw new Error(failedInfo?.reason || `TensorArt image generation ${status?.toLowerCase()}`);
        }

        await new Promise((resolve) => setTimeout(resolve, TENSOR_ART_POLL_INTERVAL_MS));
    }

    throw new Error('TensorArt image generation timed out');
};

const assertTensorArtTemplateExists = async (templateId: string) => {
    const tensorArt = createTensorArtClient();
    try {
        await tensorArt.get(`/v1/workflows/${templateId}`);
    } catch (error: any) {
        const message = error?.response?.data?.message;
        if (message) {
            throw new Error(message);
        }
        throw error;
    }
};

export const generateImageWithTensorArt = async (
    images: Express.Multer.File[],
    prompt: string,
    aspectRatio: string | undefined,
    workflowConfig: TensorArtWorkflowConfig
) => {
    const templateId = workflowConfig.templateId || DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.templateId;
    await assertTensorArtTemplateExists(templateId);
    const tensorArt = createTensorArtClient();

    const [productResourceId, modelResourceId] = await Promise.all([
        uploadTensorArtResource(images[0].path),
        uploadTensorArtResource(images[1].path),
    ]);

    const requestId = crypto.createHash('md5').update(`${Date.now()}-${crypto.randomUUID()}`).digest('hex');

    const { data } = await tensorArt.post('/v1/jobs/workflow/template', {
        request_id: requestId,
        requestId,
        templateId,
        fields: buildTensorArtFields(productResourceId, modelResourceId, prompt, aspectRatio, workflowConfig),
    });

    const jobId = data?.job?.id;
    if (!jobId) {
        throw new Error('TensorArt did not create an image generation job');
    }

    return waitForTensorArtJob(jobId);
};

const replicateOutputToUrl = (output: unknown): string => {
    if (typeof output === 'string') return output;
    if (Array.isArray(output)) {
        const first = output[0];
        if (typeof first === 'string') return first;
        if (first && typeof first === 'object' && 'url' in first) {
            const url = (first as { url?: () => string }).url;
            return typeof url === 'function' ? url() : String(first);
        }
    }
    if (output && typeof output === 'object' && 'url' in output) {
        const url = (output as { url?: () => string }).url;
        return typeof url === 'function' ? url() : '';
    }
    throw new Error('Replicate returned an unexpected image output format');
};

const requestOpenRouterImage = async ({
    apiKey,
    imageUrls,
    prompt,
    aspectRatio,
    maxTokens,
}: {
    apiKey: string;
    imageUrls: string[];
    prompt: string;
    aspectRatio?: string;
    maxTokens: number;
}) => {
    const model = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';
    const aspect = aspectRatio === '16:9' ? '16:9' : '9:16';

    const response = await axios.post(
        `${OPENROUTER_API_BASE}/chat/completions`,
        {
            model,
            max_tokens: maxTokens,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: imageUrls[0] } },
                        { type: 'image_url', image_url: { url: imageUrls[1] } },
                        { type: 'text', text: prompt },
                    ],
                },
            ],
            modalities: ['image', 'text'],
            image_config: {
                aspect_ratio: aspect,
                image_size: process.env.OPENROUTER_IMAGE_SIZE || '1K',
            },
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:5000',
                'X-Title': process.env.OPENROUTER_APP_NAME || 'UGC Project',
            },
            timeout: Number(process.env.OPENROUTER_IMAGE_TIMEOUT_MS || 180000),
            validateStatus: () => true,
        }
    );

    if (response.status >= 400) {
        const apiMessage = getAxiosErrorMessage(
            { response: { status: response.status, data: response.data } },
            ''
        );
        if (response.status === 401 || response.status === 403) {
            throw new Error(
                'OpenRouter rejected your API key (401). Create a new key at https://openrouter.ai/keys and update OPENROUTER_API_KEY in server/.env'
            );
        }
        if (response.status === 402 || isOpenRouterCreditMessage(apiMessage)) {
            throw new OpenRouterCreditError(apiMessage, parseAffordableTokens(apiMessage));
        }
        throw new Error(apiMessage || `OpenRouter image generation failed (${response.status})`);
    }

    const outputUrl = extractOpenRouterImageUrl(response.data as Record<string, unknown>);
    if (!outputUrl) {
        throw new Error('OpenRouter did not return a generated image');
    }

    return outputUrl;
};

export const generateImageWithOpenRouter = async (
    imageUrls: string[],
    prompt: string,
    aspectRatio?: string
) => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is not configured');
    }

    if (!imageUrls[0] || !imageUrls[1]) {
        throw new Error('Two reference image URLs are required for OpenRouter image generation');
    }

    const configuredMax = Number(process.env.OPENROUTER_IMAGE_MAX_TOKENS || 512);
    let maxTokens = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 512;

    try {
        return await requestOpenRouterImage({
            apiKey,
            imageUrls,
            prompt,
            aspectRatio,
            maxTokens,
        });
    } catch (error: any) {
        if (error instanceof OpenRouterCreditError && error.affordableTokens) {
            const retryTokens = Math.max(64, Math.min(maxTokens, error.affordableTokens - 16));
            if (retryTokens < maxTokens) {
                try {
                    return await requestOpenRouterImage({
                        apiKey,
                        imageUrls,
                        prompt,
                        aspectRatio,
                        maxTokens: retryTokens,
                    });
                } catch (retryError: any) {
                    if (retryError instanceof OpenRouterCreditError) {
                        throw retryError;
                    }
                    throw error;
                }
            }
        }
        throw error;
    }
};

const shouldFallbackToFreeImage = () => process.env.OPENROUTER_FALLBACK_TO_FREE !== 'false';

const generateImageWithPollinationsFallback = async (
    uploadedImageUrls: string[],
    prompt: string,
    aspectRatio?: string
) => {
    const compositeUrl = buildUgcCompositeUrl(
        uploadedImageUrls[0],
        uploadedImageUrls[1],
        aspectRatio
    );
    console.warn('[image] OpenRouter credits insufficient — using free Pollinations (flux) fallback');
    return generateImageWithPollinations(compositeUrl, prompt, aspectRatio);
};

export const generateImageWithGemini = async (
    images: Express.Multer.File[],
    prompt: string,
    aspectRatio?: string
) => {
    const apiKey = process.env.GOOGLE_CLOUD_API_KEY?.trim();
    if (!apiKey) {
        throw new Error('GOOGLE_CLOUD_API_KEY is not configured');
    }

    const model = process.env.GOOGLE_IMAGE_MODEL || 'gemini-2.5-flash-image';

    const response = await getGoogleAI().models.generateContent({
        model,
        contents: [
            fileToGenerativePart(images[0].path),
            fileToGenerativePart(images[1].path),
            { text: `Aspect ratio: ${aspectRatio === '16:9' ? '16:9' : '9:16'}. ${prompt}` },
        ],
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
        if (part.inlineData?.data) {
            const mimeType = part.inlineData.mimeType || 'image/png';
            return `data:${mimeType};base64,${part.inlineData.data}`;
        }
    }

    throw new Error('Gemini did not return a generated image');
};

export const generateImageWithReplicate = async (
    imageUrls: string[],
    prompt: string,
    aspectRatio?: string
) => {
    const token = process.env.REPLICATE_API_TOKEN?.trim();
    if (!token) {
        throw new Error('REPLICATE_API_TOKEN is not configured');
    }

    const { default: Replicate } = await import('replicate');
    const replicate = new Replicate({ auth: token });
    const model = process.env.REPLICATE_IMAGE_MODEL || 'google/nano-banana-2';

    const output = await replicate.run(model as `${string}/${string}`, {
        input: {
            prompt,
            image_input: imageUrls,
            aspect_ratio: aspectRatio === '16:9' ? '16:9' : '9:16',
            resolution: process.env.REPLICATE_IMAGE_RESOLUTION || '2K',
            output_format: 'jpg',
        },
    });

    return replicateOutputToUrl(output);
};

export const generateProjectImage = async ({
    images,
    uploadedImageUrls,
    prompt,
    aspectRatio,
}: {
    images: Express.Multer.File[];
    uploadedImageUrls: string[];
    prompt: string;
    aspectRatio?: string;
}) => {
    const configured =
        process.env.IMAGE_GENERATION_PROVIDER?.trim().toLowerCase() ||
        (process.env.OPENROUTER_API_KEY?.trim() ? 'openrouter' : '');

    if (configured === 'openrouter') {
        if (!process.env.OPENROUTER_API_KEY?.trim()) {
            throw new Error('OPENROUTER_API_KEY is not configured in server/.env');
        }
        try {
            return await generateImageWithOpenRouter(uploadedImageUrls, prompt, aspectRatio);
        } catch (error: any) {
            if (error instanceof OpenRouterCreditError && shouldFallbackToFreeImage()) {
                return generateImageWithPollinationsFallback(uploadedImageUrls, prompt, aspectRatio);
            }
            if (error instanceof OpenRouterCreditError) {
                throw new Error(
                    `OpenRouter balance is too low for AI image generation (need more than ~${error.affordableTokens ?? 0} tokens). Add credits at https://openrouter.ai/settings/credits — or set OPENROUTER_FALLBACK_TO_FREE=true (default) to use free Pollinations instead.`
                );
            }
            throw error;
        }
    }

    throw new Error(
        `Unsupported IMAGE_GENERATION_PROVIDER="${configured}". Set IMAGE_GENERATION_PROVIDER=openrouter and OPENROUTER_API_KEY in server/.env`
    );
};

export const persistGeneratedImage = async (outputUrl: string) => {
    const uploadResult = await cloudinary.uploader.upload(outputUrl, {
        resource_type: 'image',
    });
    return uploadResult.secure_url;
};
