import './env.js';
import axios from 'axios';

const OPENROUTER_API_BASE = process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1';

export type OpenRouterCreditStatus = {
    keyValid: boolean;
    hasPurchasedCredits: boolean;
    totalCredits: number;
    totalUsage: number;
    balance: number;
    message: string;
};

export const getOpenRouterCreditStatus = async (): Promise<OpenRouterCreditStatus> => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
        return {
            keyValid: false,
            hasPurchasedCredits: false,
            totalCredits: 0,
            totalUsage: 0,
            balance: 0,
            message: 'OPENROUTER_API_KEY is not set in server/.env',
        };
    }

    try {
        const { data: authData } = await axios.get(`${OPENROUTER_API_BASE}/auth/key`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 15000,
        });

        const usage = Number(authData?.data?.usage ?? 0);
        const limit = authData?.data?.limit;

        let totalCredits = typeof limit === 'number' ? limit : 0;
        let totalUsage = usage;

        try {
            const { data: creditsData } = await axios.get(`${OPENROUTER_API_BASE}/credits`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                timeout: 15000,
            });
            totalCredits = Number(creditsData?.data?.total_credits ?? totalCredits);
            totalUsage = Number(creditsData?.data?.total_usage ?? totalUsage);
        } catch {
            /* credits endpoint may be unavailable; auth/key usage is enough */
        }

        const balance = Math.max(0, totalCredits - totalUsage);
        const hasPurchasedCredits = totalCredits > 0.01 || balance > 0.01 || usage > 0;

        return {
            keyValid: true,
            hasPurchasedCredits,
            totalCredits,
            totalUsage,
            balance,
            message: hasPurchasedCredits
                ? `OpenRouter ready (~$${balance.toFixed(2)} balance remaining).`
                : 'OpenRouter key is valid. Gemini image generation will be attempted (add credits at https://openrouter.ai/settings/credits if requests fail).',
        };
    } catch (error: any) {
        const msg =
            error?.response?.data?.error?.message ||
            error?.response?.data?.message ||
            error?.message ||
            'Could not verify OpenRouter account';

        return {
            keyValid: false,
            hasPurchasedCredits: false,
            totalCredits: 0,
            totalUsage: 0,
            balance: 0,
            message: msg,
        };
    }
};

/** Validates the API key exists; does not block on credits API (often $0 until first use). */
export const assertOpenRouterConfigured = async () => {
    const status = await getOpenRouterCreditStatus();
    if (!status.keyValid) {
        throw new Error(status.message);
    }
    return status;
};
