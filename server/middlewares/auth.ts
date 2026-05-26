import { Request, Response, NextFunction } from 'express';
import * as Sentry from "@sentry/node"
import { prisma } from '../configs/prisma.js';
import { ensureUserRecord } from '../configs/userSync.js';

const isLocalDemoMode = () =>
    process.env.NODE_ENV !== 'production' && process.env.DISABLE_DEMO_AUTH_FALLBACK !== 'true';

const getBearerToken = (req: Request) => {
    const authHeader = req.headers.authorization || '';
    return authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
}

const decodeJwtPayload = (token: string) => {
    try {
        const payload = token.split('.')[1];
        if (!payload) return null;

        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const json = Buffer.from(base64, 'base64').toString('utf8');
        return JSON.parse(json);
    } catch {
        return null;
    }
}

const getDemoUserId = (req: Request) => {
    if (!isLocalDemoMode()) return null;

    const headerUserId = req.headers['x-demo-user-id'];
    if (typeof headerUserId === 'string' && headerUserId.startsWith('user_')) {
        return headerUserId;
    }

    const tokenPayload = decodeJwtPayload(getBearerToken(req));
    return tokenPayload?.sub || null;
}

const attachAuthFallback = (req: Request, userId: string) => {
    let currentAuth: any = {};

    try {
        currentAuth = typeof req.auth === 'function' ? req.auth() : {};
    } catch {
        currentAuth = {};
    }

    req.auth = () => ({
        ...currentAuth,
        userId,
        has: currentAuth?.has || (() => false),
    });
}

const ensureDemoCredits = async (userId: string) => {
    if (!isLocalDemoMode()) return;

    await prisma.user.upsert({
        where: { id: userId },
        update: {
            credits: { increment: 0 },
        },
        create: {
            id: userId,
            email: `${userId}@demo.local`,
            name: 'Demo User',
            image: '',
            credits: 50,
        },
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user && user.credits < 20) {
        await prisma.user.update({
            where: { id: userId },
            data: { credits: 50 },
        });
    }
}

export const protect = async (req: Request, res: Response, next: NextFunction)=>{
    try {
        let userId: string | null = null;

        try {
            userId = req.auth()?.userId || null;
        } catch (error) {
            if (!isLocalDemoMode()) {
                throw error;
            }
        }

        if(!userId) {
            userId = getDemoUserId(req);
            if(userId) attachAuthFallback(req, userId);
        }

        if(!userId) {
            return res.status(401).json({message: 'Unauthorized'})
        }

        await ensureDemoCredits(userId);
        await ensureUserRecord(userId);

        next()
    } catch (error: any) {
        Sentry.captureException(error)
        res.status(401).json({message: error.code || error.message})
    }
}
