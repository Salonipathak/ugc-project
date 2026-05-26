import '../configs/env.js';
import axios from 'axios';
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { v2 as cloudinary } from 'cloudinary';

const mask = (v) => {
    if (!v) return '(missing)';
    if (v.length <= 12) return '***';
    return `${v.slice(0, 8)}…${v.slice(-4)}`;
};

const log = (name, ok, detail) => console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);

// Database
try {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    const prisma = new PrismaClient({ adapter });
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    log('Database (Neon)', true, 'connected');
} catch (e) {
    log('Database (Neon)', false, e.message);
}

// Clerk secret
try {
    const r = await axios.get('https://api.clerk.com/v1/users?limit=1', {
        headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
        validateStatus: () => true,
    });
    log(
        'Clerk secret key',
        r.status === 200,
        r.status === 200 ? 'valid' : `HTTP ${r.status} — get keys from dashboard.clerk.com`
    );
} catch (e) {
    log('Clerk secret key', false, e.message);
}

// Cloudinary
try {
    if (!process.env.CLOUDINARY_URL) throw new Error('CLOUDINARY_URL not set');
    cloudinary.config({ secure: true });
    const r = await cloudinary.api.ping();
    log('Cloudinary', true, r.status || 'reachable');
} catch (e) {
    log('Cloudinary', false, e.message || e.error?.message);
}

// OpenRouter auth + credits hint
try {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (!key) throw new Error('OPENROUTER_API_KEY not set');
    const r = await axios.get('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${key}` },
        validateStatus: () => true,
    });
    if (r.status === 200) {
        const usage = r.data?.data?.usage;
        const limit = r.data?.data?.limit;
        log(
            'OpenRouter API key',
            true,
            `valid (usage: ${usage ?? '?'} / limit: ${limit ?? 'none'})`
        );
    } else {
        log('OpenRouter API key', false, r.data?.error?.message || `HTTP ${r.status}`);
    }
} catch (e) {
    log('OpenRouter API key', false, e.message);
}

// OpenRouter video model listing (lightweight)
try {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    const r = await axios.get('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        validateStatus: () => true,
    });
    const imageModel = process.env.OPENROUTER_IMAGE_MODEL;
    const videoModel = process.env.OPENROUTER_VIDEO_MODEL;
    const ids = (r.data?.data || []).map((m) => m.id);
    const hasImage = ids.some((id) => id === imageModel || id.includes('gemini'));
    log(
        'OpenRouter image model',
        ids.includes(imageModel),
        ids.includes(imageModel) ? imageModel : `"${imageModel}" not in catalog — check openrouter.ai/models`
    );
    log(
        'OpenRouter video model',
        ids.includes(videoModel) || videoModel.includes('veo'),
        videoModel + (ids.includes(videoModel) ? '' : ' (may still work for /videos API)')
    );
} catch (e) {
    log('OpenRouter models', false, e.message);
}

console.log('\nConfigured keys (masked):');
console.log('  OPENROUTER_API_KEY:', mask(process.env.OPENROUTER_API_KEY));
console.log('  CLERK_SECRET_KEY:', mask(process.env.CLERK_SECRET_KEY));
console.log('  CLOUDINARY_URL:', process.env.CLOUDINARY_URL ? 'set' : 'missing');
