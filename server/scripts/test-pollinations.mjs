import axios from 'axios';

const prompt =
    'Professional UGC lifestyle photo, person naturally holding cosmetic product, studio lighting, photorealistic';

async function tryLabel(label, params) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
    try {
        const r = await axios.get(url, {
            responseType: 'arraybuffer',
            validateStatus: () => true,
            timeout: 120000,
            maxRedirects: 5,
        });
        const ct = r.headers['content-type'] || '';
        const isImage = ct.includes('image');
        console.log(label, '->', r.status, ct, isImage ? `${r.data.byteLength} bytes` : String(r.data).slice(0, 120));
    } catch (e) {
        console.log(label, '-> ERR', e.message);
    }
}

await tryLabel(
    'flux 768x1344',
    new URLSearchParams({ model: 'flux', width: '768', height: '1344', nologo: 'true' })
);
await tryLabel(
    'flux 1024',
    new URLSearchParams({ model: 'flux', width: '1024', height: '1024', nologo: 'true' })
);
await tryLabel(
    'turbo',
    new URLSearchParams({ model: 'turbo', width: '768', height: '1344', nologo: 'true' })
);
await tryLabel(
    'kontext+image',
    new URLSearchParams({
        model: 'kontext',
        width: '768',
        height: '1344',
        image: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400',
        nologo: 'true',
    })
);
await tryLabel(
    'kontext no enhance',
    new URLSearchParams({
        model: 'kontext',
        width: '768',
        height: '1344',
        image: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400',
        nologo: 'true',
        enhance: 'false',
    })
);
