export const authHeaders = (token: string | null, userId?: string) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(userId ? { 'x-demo-user-id': userId } : {}),
});
