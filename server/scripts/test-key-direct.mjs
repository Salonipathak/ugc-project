import '../configs/env.js';
import axios from 'axios';

const key = process.env.OPENROUTER_API_KEY?.trim();
console.log('Key ends with:', key?.slice(-6));

const credits = await axios.get('https://openrouter.ai/api/v1/credits', {
    headers: { Authorization: `Bearer ${key}` },
    validateStatus: () => true,
});
console.log('credits', credits.status, JSON.stringify(credits.data));

const gen = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
        model: 'google/gemini-2.5-flash-image',
        max_tokens: 4096,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: {
                            url: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=512',
                        },
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=512',
                        },
                    },
                    { type: 'text', text: 'UGC lifestyle photo, person holding product, photorealistic' },
                ],
            },
        ],
        modalities: ['image', 'text'],
        image_config: { aspect_ratio: '9:16', image_size: '1K' },
    },
    {
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        validateStatus: () => true,
        timeout: 180000,
    }
);

console.log('generate', gen.status);
if (gen.status !== 200) {
    console.log('error', JSON.stringify(gen.data).slice(0, 500));
} else {
    const images = gen.data?.choices?.[0]?.message?.images;
    console.log('SUCCESS images:', images?.length ?? 0);
}
