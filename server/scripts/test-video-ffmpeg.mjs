import '../configs/env.js';
import fs from 'fs';
import { generateVideoWithFfmpeg } from '../configs/freeGeneration.js';

const url = process.argv[2] || 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=600';
console.log('image:', url);
const started = Date.now();
async function main() {
    const out = await generateVideoWithFfmpeg({
        imageUrl: url,
        durationSec: 5,
        aspectRatio: '9:16',
    });
    console.log('ok in', Date.now() - started, 'ms ->', out, 'bytes', fs.statSync(out).size);
}

main().catch((e) => {
    console.error('FAIL', e.message);
    process.exit(1);
});
