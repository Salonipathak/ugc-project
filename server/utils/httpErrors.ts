export const getAxiosErrorMessage = (error: unknown, fallback = 'Request failed') => {
    if (!error || typeof error !== 'object') {
        return fallback;
    }

    const err = error as {
        message?: string;
        response?: { status?: number; data?: unknown };
    };

    const data = err.response?.data as
        | { message?: string; error?: string | { message?: string } }
        | string
        | undefined;

    if (typeof data === 'string' && data.trim()) {
        return data;
    }

    if (data && typeof data === 'object') {
        const nested = data.error;
        if (typeof nested === 'string' && nested.trim()) {
            return nested;
        }
        if (nested && typeof nested === 'object' && nested.message) {
            return nested.message;
        }
        if (data.message) {
            return data.message;
        }
    }

    if (err.response?.status === 401) {
        return 'Unauthorized — sign in again or check your API key';
    }

    return err.message || fallback;
};
