import { prisma } from './prisma.js';

/** Ensures a Clerk user exists in Postgres (webhook may not have fired in local dev). */
export const ensureUserRecord = async (userId: string) => {
    return prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: {
            id: userId,
            email: '',
            name: 'User',
            image: '',
            credits: 20,
        },
    });
};
