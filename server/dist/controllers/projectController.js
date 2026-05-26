import * as Sentry from "@sentry/node";
import { prisma } from '../configs/prisma.js';
import { cloudinary } from '../configs/cloudinary.js';
import { buildPrompt, generateProjectImage, persistGeneratedImage, } from '../configs/imageGeneration.js';
import { buildVideoGenerationPrompt, generateProjectVideo, } from '../configs/videoGeneration.js';
import fs from 'fs';
import { getAxiosErrorMessage } from '../utils/httpErrors.js';
import { ensureUserRecord } from '../configs/userSync.js';
const isFallbackGeneratedImage = (generatedImage) => {
    if (!generatedImage)
        return false;
    return generatedImage.includes('/upload/') && generatedImage.includes('/l_') && generatedImage.includes('/fl_layer_apply');
};
const removeFallbackGeneratedImage = (project) => ({
    ...project,
    generatedImage: isFallbackGeneratedImage(project.generatedImage) ? '' : project.generatedImage,
});
export const createProject = async (req, res) => {
    let tempProjectId;
    const { userId } = req.auth();
    let isCreditDeducted = false;
    const { name = 'New Project', aspectRatio, userPrompt, productName, productDescription, targetLength = 5 } = req.body;
    const images = req.files;
    if (!Array.isArray(images) || images.length < 2 || !productName) {
        return res.status(400).json({ message: 'Please upload at least 2 images' });
    }
    const user = await ensureUserRecord(userId);
    if (user.credits < 5) {
        return res.status(402).json({
            message: `Insufficient credits (${user.credits} left, need 5). Visit /plans to get more.`,
        });
    }
    else {
        // deduct credits for image generation
        await prisma.user
            .update({
            where: { id: userId },
            data: { credits: { decrement: 5 } },
        })
            .then(() => {
            isCreditDeducted = true;
        });
    }
    try {
        let uploadedImageResults = await Promise.all(images.map(async (item) => {
            let result = await cloudinary.uploader.upload(item.path, { resource_type: 'image' });
            return result.secure_url;
        }));
        const project = await prisma.project.create({
            data: {
                name,
                userId,
                productName,
                productDescription,
                userPrompt,
                aspectRatio,
                targetLength: parseInt(targetLength),
                uploadedImages: uploadedImageResults,
                isGenerating: true
            }
        });
        tempProjectId = project.id;
        const prompt = buildPrompt(productName, productDescription, userPrompt);
        const outputUrl = await generateProjectImage({
            images,
            uploadedImageUrls: uploadedImageResults,
            prompt,
            aspectRatio,
        });
        const generatedImage = await persistGeneratedImage(outputUrl);
        await prisma.project.update({
            where: { id: project.id },
            data: {
                generatedImage,
                isGenerating: false,
                error: ''
            }
        });
        res.json({ projectId: project.id, message: 'Image generated successfully' });
    }
    catch (error) {
        if (tempProjectId) {
            // update project status and error message
            await prisma.project.update({
                where: { id: tempProjectId },
                data: { isGenerating: false, error: error.message }
            });
        }
        if (isCreditDeducted) {
            // add credits back
            await prisma.user.update({
                where: { id: userId },
                data: { credits: { increment: 5 } },
            });
        }
        Sentry.captureException(error);
        res.status(500).json({ message: getAxiosErrorMessage(error) });
    }
};
const runVideoGenerationJob = async ({ projectId, userId, refundCreditsOnFailure, }) => {
    let tempVideoPath;
    try {
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId },
        });
        if (!project?.generatedImage) {
            throw new Error('Generated image not found');
        }
        const prompt = buildVideoGenerationPrompt({
            productName: project.productName,
            productDescription: project.productDescription,
            userPrompt: project.userPrompt,
            aspectRatio: project.aspectRatio || '9:16',
        });
        tempVideoPath = await generateProjectVideo({
            imageUrl: project.generatedImage,
            prompt,
            aspectRatio: project.aspectRatio || '9:16',
            targetLength: project.targetLength,
            userId,
        });
        const uploadResult = await cloudinary.uploader.upload(tempVideoPath, {
            resource_type: 'video',
        });
        await prisma.project.update({
            where: { id: projectId },
            data: {
                generatedVideo: uploadResult.secure_url,
                isGenerating: false,
                error: '',
            },
        });
    }
    catch (error) {
        await prisma.project.updateMany({
            where: { id: projectId, userId },
            data: { isGenerating: false, error: error.message },
        });
        if (refundCreditsOnFailure) {
            await prisma.user.update({
                where: { id: userId },
                data: { credits: { increment: 10 } },
            });
        }
        Sentry.captureException(error);
    }
    finally {
        if (tempVideoPath && fs.existsSync(tempVideoPath)) {
            fs.unlinkSync(tempVideoPath);
        }
    }
};
export const createVideo = async (req, res) => {
    const { userId } = req.auth();
    const { projectId } = req.body;
    if (!projectId) {
        return res.status(400).json({ message: 'Project ID is required' });
    }
    try {
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId },
        });
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }
        if (project.isGenerating) {
            return res.status(202).json({
                message: 'Video generation already in progress',
                projectId,
                status: 'processing',
            });
        }
        if (project.generatedVideo) {
            return res.status(400).json({ message: 'Video already generated' });
        }
        if (!project.generatedImage) {
            return res.status(400).json({ message: 'Generated image not found' });
        }
        const user = await ensureUserRecord(userId);
        if (user.credits < 10) {
            return res.status(402).json({
                message: `Insufficient credits (${user.credits} left, need 10). Visit /plans to get more.`,
            });
        }
        await prisma.user.update({
            where: { id: userId },
            data: { credits: { decrement: 10 } },
        });
        await prisma.project.update({
            where: { id: projectId },
            data: { isGenerating: true, error: '' },
        });
        void runVideoGenerationJob({
            projectId,
            userId,
            refundCreditsOnFailure: true,
        });
        res.status(202).json({
            message: 'Video generation started',
            projectId,
            status: 'processing',
        });
    }
    catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
};
export const getAllPublishedProjects = async (req, res) => {
    try {
        const projects = await prisma.project.findMany({
            where: { isPublished: true }
        });
        res.json({ projects: projects.map(removeFallbackGeneratedImage) });
    }
    catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
};
export const deleteProject = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { projectId } = req.params;
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId },
        });
        if (!project) {
            return res.status(404).json({ message: "Project not found" });
        }
        await prisma.project.delete({
            where: { id: projectId },
        });
        res.json({ message: "Project deleted" });
    }
    catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
};
