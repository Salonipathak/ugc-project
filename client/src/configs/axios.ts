import axios from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_BASEURL || 'http://localhost:5000',
});

api.interceptors.response.use(
    (response) => response,
    (error) => {
        const message =
            error?.response?.data?.message ||
            (typeof error?.response?.data?.error === 'string'
                ? error.response.data.error
                : error?.response?.data?.error?.message);

        if (message) {
            error.message = message;
        }

        return Promise.reject(error);
    }
);

export default api;