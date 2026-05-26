import * as Sentry from "@sentry/node";
import { prisma } from '../configs/prisma.js';
const isFallbackGeneratedImage = (generatedImage) => {
    if (!generatedImage)
        return false;
    return generatedImage.includes('/upload/') && generatedImage.includes('/l_') && generatedImage.includes('/fl_layer_apply');
};
const removeFallbackGeneratedImage = (project) => ({
    ...project,
    generatedImage: isFallbackGeneratedImage(project.generatedImage) ? '' : project.generatedImage,
});
// Get User Credits
export const getUserCredits = async (req, res) => {
    try {
        const { userId } = req.auth();
        if (!userId) {
            return res.status(401).json({ message: "Unauthorized" });
        }
        const user = await prisma.user.findUnique({
            where: { id: userId },
        });
        res.json({ credits: user?.credits });
    }
    catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.code || error.message });
    }
};
//  const get all user projects
export const getAllProjects = async (req, res) => {
    try {
        const { userId } = req.auth();
        const projects = await prisma.project.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' }
        });
        res.json({ projects: projects.map(removeFallbackGeneratedImage) });
    }
    catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.code || error.message });
    }
};
// get project by id
export const getProjectById = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { projectId } = req.params;
        const project = await prisma.project.findUnique({
            where: { id: projectId, userId }
        });
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }
        res.json({ project: removeFallbackGeneratedImage(project) });
    }
    catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.code || error.message });
    }
};
// publish / unpublish project
export const toggleProjectPublic = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { projectId } = req.params;
        const project = await prisma.project.findFirst({
            where: { id: projectId, userId },
        });
        if (!project) {
            return res.status(404).json({ message: "Project not found" });
        }
        if (!project?.generatedImage && !project?.generatedVideo) {
            return res.status(404).json({ message: "image or video not generated" });
        }
        await prisma.project.update({
            where: { id: projectId },
            data: { isPublished: !project.isPublished }
        });
        res.json({ isPublished: !project.isPublished });
    }
    catch (error) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.code || error.message });
    }
};
