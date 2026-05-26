import './env.js';
import { GoogleGenAI } from '@google/genai';

let cachedClient: GoogleGenAI | null = null;

/** Only initializes when GOOGLE_CLOUD_API_KEY is set (avoids startup warnings on OpenRouter-only setups). */
export const getGoogleAI = () => {
    const apiKey = process.env.GOOGLE_CLOUD_API_KEY?.trim();
    if (!apiKey) {
        throw new Error('GOOGLE_CLOUD_API_KEY is not configured');
    }
    if (!cachedClient) {
        cachedClient = new GoogleGenAI({ apiKey });
    }
    return cachedClient;
};
