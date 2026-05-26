import '../configs/env.js';

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

console.log('\n--- Summary ---');
const failed = results.filter((r) => !r.ok);
if (!failed.length) console.log('All checks passed.');
else failed.forEach((r) => console.log(`- ${r.name}: ${r.detail}`));
