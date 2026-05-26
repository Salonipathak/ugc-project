import { Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { prisma } from '../configs/prisma.js';
import { cloudinary } from '../configs/cloudinary.js';
import {
    buildPrompt,
    generateProjectImage,
    persistGeneratedImage,
} from '../configs/imageGeneration.js';
import { getAxiosErrorMessage } from '../utils/httpErrors.js';
import { ensureUserRecord } from '../configs/userSync.js';

const isFallbackGeneratedImage = (generatedImage?: string | null) => {
    if (!generatedImage) return false;
    return generatedImage.includes('/upload/') && generatedImage.includes('/l_') && generatedImage.includes('/fl_layer_apply');
}

const removeFallbackGeneratedImage = <T extends { generatedImage: string | null }>(project: T) => ({
    ...project,
    generatedImage: isFallbackGeneratedImage(project.generatedImage) ? '' : project.generatedImage,
});

export const createProject = async (req:Request, res: Response) => {
    let tempProjectId: string | undefined;
    const { userId } = req.auth();
    let isCreditDeducted = false;

    const {name = 'New Project', aspectRatio, userPrompt, productName, productDescription, targetLength = 5} = req.body;

  const images = req.files as Express.Multer.File[] | undefined;

    if(!Array.isArray(images) || images.length < 2 || !productName){
        return res.status(400).json({message: 'Please upload at least 2 images'})
    }

  const user = await ensureUserRecord(userId);

  if (user.credits < 5) {
    return res.status(402).json({
      message: `Insufficient credits (${user.credits} left, need 5). Visit /plans to get more.`,
    });
  } else {
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

        let uploadedImageResults = await Promise.all(
            images.map(async(item: any)=>{
                let result = await cloudinary.uploader.upload(item.path, {resource_type: 'image'});
                return result.secure_url;
            })
        )

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
         })

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
            where: {id: project.id},
            data: {
                generatedImage,
                isGenerating: false,
                error: ''
            }
         })

         res.json({projectId: project.id, message: 'Image generated successfully'})
        
    } catch (error:any) {
        if(tempProjectId){
            // update project status and error message
            await prisma.project.update({
                where: {id: tempProjectId},
                data: {isGenerating: false, error: error.message}
            })
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

export const getAllPublishedProjects = async (req:Request, res: Response) => {
    try {
        const projects = await prisma.project.findMany({
            where: {isPublished: true}
        })
        res.json({projects: projects.map(removeFallbackGeneratedImage)})

    } catch (error:any) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}

export const deleteProject = async (req: Request, res: Response) => {
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
  } catch (error: any) {
    Sentry.captureException(error);
    res.status(500).json({ message: error.message });
  }
};
