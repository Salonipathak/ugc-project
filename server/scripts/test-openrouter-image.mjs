import '../configs/env.js';
import { generateImageWithOpenRouter } from '../configs/imageGeneration.js';

const urls = [
    'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=512',
    'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=512',
];

console.log('Testing OpenRouter image generation...');
console.log('Model:', process.env.OPENROUTER_IMAGE_MODEL);
console.log('max_tokens:', process.env.OPENROUTER_IMAGE_MAX_TOKENS);
console.log('image_size:', process.env.OPENROUTER_IMAGE_SIZE);

try {
    const started = Date.now();
    const out = await generateImageWithOpenRouter(
        urls,
        'Professional UGC photo, woman holding skincare product, photorealistic studio lighting',
        '9:16'
    );
    console.log('SUCCESS in', Date.now() - started, 'ms');
    console.log('Output type:', out.startsWith('data:') ? 'base64 data URL' : 'URL');
    console.log('Preview:', out.slice(0, 80) + '...');
} catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
}
