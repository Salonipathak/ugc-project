import '../configs/env.js';
import axios from 'axios';
import { getGoogleAI } from '../configs/ai.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const results = [];

const log = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK' : 'FAIL'} ${name}: ${detail}`);
};

// OpenRouter
try {
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
        log('OpenRouter', false, 'OPENROUTER_API_KEY not set in server/.env');
    } else {
        const { generateImageWithOpenRouter } = await import('../configs/imageGeneration.js');
        const url = await generateImageWithOpenRouter(
            [
                'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
                'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400',
            ],
            'Combine into one lifestyle product photo',
            '9:16'
        );
        log('OpenRouter generation', true, `output: ${url.slice(0, 60)}...`);
    }
} catch (e) {
    log('OpenRouter generation', false, e?.response?.data?.error?.message || e?.message?.slice(0, 300) || String(e));
}

// TensorArt template
try {
    const client = axios.create({
        baseURL: process.env.TENSOR_ART_API_BASE || 'https://ap-east-1.tensorart.cloud',
        headers: {
            Authorization: `Bearer ${process.env.TENSOR_ART_API_KEY}`,
            'Content-Type': 'application/json',
        },
    });
    const templateId = process.env.TENSOR_ART_TEMPLATE_ID;
    const r = await client.get(`/v1/workflows/${templateId}`);
    const name = r.data?.workflow?.name || r.data?.name || 'found';
    log('TensorArt template', true, `template ${templateId} exists (${name})`);
} catch (e) {
    log('TensorArt template', false, e.response?.data?.message || e.message);
}

// Google Gemini image
try {
    const dir = path.join(os.tmpdir(), 'ugc-check');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 't.png');
    fs.writeFileSync(
        p,
        Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        )
    );
    const part = {
        inlineData: { data: fs.readFileSync(p).toString('base64'), mimeType: 'image/png' },
    };
    await getGoogleAI().models.generateContent({
        model: process.env.GOOGLE_IMAGE_MODEL || 'gemini-2.5-flash-image',
        contents: [part, 'Say OK in one word only'],
    });
    log('Google Gemini', true, 'API reachable');
} catch (e) {
    const msg = e?.message || String(e);
    log('Google Gemini', false, msg.slice(0, 300));
}

// Replicate account
try {
    const { default: Replicate } = await import('replicate');
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const account = await replicate.accounts.current();
    log('Replicate account', true, `username: ${account?.username || 'ok'}`);
} catch (e) {
    log('Replicate account', false, e?.message?.slice(0, 300) || String(e));
}

// Replicate model prediction (dry - just check model exists via models.get if available)
try {
    const { default: Replicate } = await import('replicate');
    const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
    const model = process.env.REPLICATE_IMAGE_MODEL || 'google/nano-banana-2';
    const [owner, name] = model.split('/');
    await replicate.models.get(owner, name);
    log('Replicate model', true, model);
} catch (e) {
    log('Replicate model', false, e?.message?.slice(0, 300) || String(e));
}

// Replicate generation (costs credits)
try {
    const { generateImageWithReplicate } = await import('../configs/imageGeneration.js');
    const url = await generateImageWithReplicate(
        [
            'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=200',
            'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200',
        ],
        'Combine product and person in a lifestyle photo',
        '9:16'
    );
    log('Replicate generation', true, `output: ${url.slice(0, 60)}...`);
} catch (e) {
    log('Replicate generation', false, e?.message?.slice(0, 300) || String(e));
}

console.log('\n--- Summary ---');
const failed = results.filter((r) => !r.ok);
if (!failed.length) console.log('All checks passed.');
else failed.forEach((r) => console.log(`- ${r.name}: ${r.detail}`));
