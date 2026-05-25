import { Request, Response } from "express";
import * as Sentry from "@sentry/node";
import { prisma } from '../configs/prisma.js';
import {v2 as cloudinary } from 'cloudinary'
import fs from 'fs';
import path from 'path';
import ai from '../configs/ai.js';
import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const TENSOR_ART_API_BASE = process.env.TENSOR_ART_API_BASE || 'https://ap-east-1.tensorart.cloud';
const TENSOR_ART_POLL_INTERVAL_MS = Number(process.env.TENSOR_ART_POLL_INTERVAL_MS || 5000);
const TENSOR_ART_POLL_TIMEOUT_MS = Number(process.env.TENSOR_ART_POLL_TIMEOUT_MS || 180000);
const DEFAULT_TENSOR_ART_WORKFLOW_CONFIG = {
    templateId: '1002579564481744204',
    productImageNodeId: '60',
    modelImageNodeId: '63',
    promptNodeId: '6',
};

type TensorArtFieldAttr = {
    nodeId: string;
    fieldName: string;
    fieldValue: string | number;
}

type TensorArtWorkflowConfig = {
    templateId?: string;
    productImageNodeId?: string;
    modelImageNodeId?: string;
    promptNodeId?: string;
    negativePromptNodeId?: string;
    widthNodeId?: string;
    heightNodeId?: string;
    aspectRatioNodeId?: string;
}

const createTensorArtClient = () => {
    if (!process.env.TENSOR_ART_API_KEY) {
        throw new Error('TENSOR_ART_API_KEY is not configured');
    }

    return axios.create({
        baseURL: TENSOR_ART_API_BASE,
        headers: {
            Authorization: `Bearer ${process.env.TENSOR_ART_API_KEY}`,
            'Content-Type': 'application/json',
        },
    });
}

const isFallbackGeneratedImage = (generatedImage?: string | null) => {
    if (!generatedImage) return false;
    return generatedImage.includes('/upload/') && generatedImage.includes('/l_') && generatedImage.includes('/fl_layer_apply');
}

const removeFallbackGeneratedImage = <T extends { generatedImage: string | null }>(project: T) => ({
    ...project,
    generatedImage: isFallbackGeneratedImage(project.generatedImage) ? '' : project.generatedImage,
});

const buildPrompt = (productName: string, productDescription?: string, userPrompt?: string) => {
    return `Combine reference image 1, the product, with reference image 2, the person, into one realistic ecommerce lifestyle photo.
Make the person naturally hold or use the product.
Preserve the product identity, shape, colors, and visible details.
Preserve the person's likeness while matching lighting, shadows, scale, and perspective.
Use professional studio lighting and produce photorealistic, commercial-quality imagery.
Product name: ${productName}.
${productDescription ? `Product description: ${productDescription}.` : ''}
${userPrompt ? `Additional direction: ${userPrompt}` : ''}`
}

const getTensorArtDimensions = (aspectRatio?: string) => {
    if (aspectRatio === '16:9') {
        return { width: 1344, height: 768 };
    }

    return { width: 768, height: 1344 };
}

const uploadTensorArtResource = async (filePath: string) => {
    const tensorArt = createTensorArtClient();
    const { data } = await tensorArt.post('/v1/resource/image', { expireSec: 3600 });

    if (!data?.resourceId || !data?.putUrl) {
        throw new Error('TensorArt did not return a resource upload URL');
    }

    await axios.put(data.putUrl, fs.createReadStream(filePath), {
        headers: data.headers || { 'Content-Type': 'application/octet-stream' },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

    return data.resourceId as string;
}

const addEnvField = (
    fieldAttrs: TensorArtFieldAttr[],
    nodeId: string | undefined,
    defaultFieldName: string,
    fieldValue: string | number,
    fieldName?: string
) => {
    if (!nodeId) return;

    fieldAttrs.push({
        nodeId,
        fieldName: fieldName || defaultFieldName,
        fieldValue,
    });
}

const buildTensorArtFields = (
    productResourceId: string,
    modelResourceId: string,
    prompt: string,
    aspectRatio: string | undefined,
    workflowConfig: TensorArtWorkflowConfig
) => {
    const fieldAttrs: TensorArtFieldAttr[] = [];
    const { width, height } = getTensorArtDimensions(aspectRatio);

    addEnvField(fieldAttrs, workflowConfig.productImageNodeId, process.env.TENSOR_ART_PRODUCT_IMAGE_FIELD_NAME || 'image', productResourceId);
    addEnvField(fieldAttrs, workflowConfig.modelImageNodeId, process.env.TENSOR_ART_MODEL_IMAGE_FIELD_NAME || 'image', modelResourceId);
    addEnvField(fieldAttrs, workflowConfig.promptNodeId, process.env.TENSOR_ART_PROMPT_FIELD_NAME || 'text', prompt);
    addEnvField(
        fieldAttrs,
        workflowConfig.negativePromptNodeId,
        process.env.TENSOR_ART_NEGATIVE_PROMPT_FIELD_NAME || 'text',
        'blurry, low quality, distorted hands, extra fingers, missing fingers, bad anatomy, duplicate person, watermark, logo, text artifacts'
    );
    addEnvField(fieldAttrs, workflowConfig.widthNodeId, process.env.TENSOR_ART_WIDTH_FIELD_NAME || 'width', width);
    addEnvField(fieldAttrs, workflowConfig.heightNodeId, process.env.TENSOR_ART_HEIGHT_FIELD_NAME || 'height', height);
    addEnvField(fieldAttrs, workflowConfig.aspectRatioNodeId, process.env.TENSOR_ART_ASPECT_RATIO_FIELD_NAME || 'text', aspectRatio || '9:16');

    if (fieldAttrs.length < 3) {
        throw new Error('TensorArt workflow fields are missing. Product image, model image, and prompt node IDs are required.');
    }

    return { fieldAttrs };
}

const getTensorArtOutputUrl = (job: any) => {
    const successImage = job?.successInfo?.images?.[0]?.url;
    if (successImage) return successImage;

    const nodes = job?.runningInfo?.workflowFinishItem?.nodes || job?.successInfo?.workflowFinishItem?.nodes || {};
    for (const node of Object.values(nodes) as any[]) {
        const outputImage = node?.outputUi?.images?.[0]?.filename;
        if (outputImage) return outputImage;
    }

    return '';
}

const waitForTensorArtJob = async (jobId: string) => {
    const tensorArt = createTensorArtClient();
    const startedAt = Date.now();

    while (Date.now() - startedAt < TENSOR_ART_POLL_TIMEOUT_MS) {
        const { data } = await tensorArt.get(`/v1/jobs/${jobId}`);
        const job = data?.job;

        if (job?.status === 'SUCCESS') {
            const outputUrl = getTensorArtOutputUrl(job);
            if (!outputUrl) {
                throw new Error('TensorArt completed without returning an image URL');
            }
            return outputUrl;
        }

        if (job?.status === 'FAILED' || job?.status === 'CANCELED') {
            throw new Error(job?.failedInfo?.reason || `TensorArt image generation ${job.status.toLowerCase()}`);
        }

        await new Promise((resolve) => setTimeout(resolve, TENSOR_ART_POLL_INTERVAL_MS));
    }

    throw new Error('TensorArt image generation timed out');
}

const generateImageWithTensorArt = async (
    images: any[],
    prompt: string,
    aspectRatio: string | undefined,
    workflowConfig: TensorArtWorkflowConfig
) => {
    const templateId = workflowConfig.templateId || DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.templateId;

    const tensorArt = createTensorArtClient();
    const [productResourceId, modelResourceId] = await Promise.all([
        uploadTensorArtResource(images[0].path),
        uploadTensorArtResource(images[1].path),
    ]);

    const { data } = await tensorArt.post('/v1/jobs/workflow/template', {
        requestId: crypto.createHash('md5').update(`${Date.now()}-${crypto.randomUUID()}`).digest('hex'),
        templateId,
        fields: buildTensorArtFields(productResourceId, modelResourceId, prompt, aspectRatio, workflowConfig),
    });

    const jobId = data?.job?.id;
    if (!jobId) {
        throw new Error('TensorArt did not create an image generation job');
    }

    return waitForTensorArtJob(jobId);
}

const getTensorArtWorkflowConfig = (body: any): TensorArtWorkflowConfig => ({
    templateId: body.tensorArtTemplateId || process.env.TENSOR_ART_TEMPLATE_ID || DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.templateId,
    productImageNodeId: body.tensorArtProductImageNodeId || process.env.TENSOR_ART_PRODUCT_IMAGE_NODE_ID || DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.productImageNodeId,
    modelImageNodeId: body.tensorArtModelImageNodeId || process.env.TENSOR_ART_MODEL_IMAGE_NODE_ID || DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.modelImageNodeId,
    promptNodeId: body.tensorArtPromptNodeId || process.env.TENSOR_ART_PROMPT_NODE_ID || DEFAULT_TENSOR_ART_WORKFLOW_CONFIG.promptNodeId,
    negativePromptNodeId: body.tensorArtNegativePromptNodeId || process.env.TENSOR_ART_NEGATIVE_PROMPT_NODE_ID,
    widthNodeId: body.tensorArtWidthNodeId || process.env.TENSOR_ART_WIDTH_NODE_ID,
    heightNodeId: body.tensorArtHeightNodeId || process.env.TENSOR_ART_HEIGHT_NODE_ID,
    aspectRatioNodeId: body.tensorArtAspectRatioNodeId || process.env.TENSOR_ART_ASPECT_RATIO_NODE_ID,
});


export const createProject = async (req:Request, res: Response) => {
    let tempProjectId: string | undefined;
    const { userId } = req.auth();
    let isCreditDeducted = false;

    const {name = 'New Project', aspectRatio, userPrompt, productName, productDescription, targetLength = 5} = req.body;
    const tensorArtWorkflowConfig = getTensorArtWorkflowConfig(req.body);

  const images = req.files as Express.Multer.File[] | undefined;

    if(!Array.isArray(images) || images.length < 2 || !productName){
        return res.status(400).json({message: 'Please upload at least 2 images'})
    }

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user || user.credits < 5) {
    return res.status(401).json({ message: "Insufficient credits" });
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

         let generatedImage = '';

         try {
            const outputUrl = await generateImageWithTensorArt(images, prompt, aspectRatio, tensorArtWorkflowConfig);
            const uploadResult = await cloudinary.uploader.upload(outputUrl, {resource_type: 'image'});
            generatedImage = uploadResult.secure_url;
         } catch (generationErrorObject: any) {
            console.error("FULL IMAGE ERROR:", generationErrorObject);

            Sentry.captureException(generationErrorObject);
            throw generationErrorObject;
         }

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
    res.status(500).json({ message: error.message });
  }
};

export const createVideo = async (req: Request, res: Response) => {
  const { userId } = req.auth();
  const { projectId } = req.body;
  let isCreditDeducted = false;
  let fallbackVideoUploaded = false;
  let project: any = null;

  if (!projectId) {
    return res.status(400).json({ message: "Project ID is required" });
  }

  try {
    project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      include: { user: true },
    });

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    if (project.isGenerating) {
      return res.status(409).json({ message: "Generation in progress" });
    }

    if (project.generatedVideo) {
      return res.status(400).json({ message: "Video already generated" });
    }

    if (!project.generatedImage) {
      return res.status(400).json({ message: "Generated image not found" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || user.credits < 10) {
      return res.status(401).json({ message: "Insufficient credits" });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { credits: { decrement: 10 } },
    });
    isCreditDeducted = true;

    await prisma.project.update({
      where: { id: projectId },
      data: { isGenerating: true },
    });

    const prompt = buildVideoGenerationPrompt({
      productName: project.productName,
      productDescription: project.productDescription,
      userPrompt: project.userPrompt,
      aspectRatio: project.aspectRatio || "9:16",
    });

    const model = "veo-3.1-generate-preview";

    const image = await axios.get(project.generatedImage, {
      responseType: "arraybuffer",
    });

    const imageBytes: any = Buffer.from(image.data);

    let operation: any = await ai.models.generateVideos({
      model,
      prompt,
      image: {
        imageBytes: imageBytes.toString("base64"),
        mimeType: "image/png",
      },
      config: {
        aspectRatio: project?.aspectRatio || "9:16",
        numberOfVideos: 1,
        resolution: "720p",
      },
    });

    while (!operation.done) {
      console.log("Waiting for video generation to complete...");
      await new Promise((resolve) => setTimeout(resolve, 10000));
      operation = await ai.operations.getVideosOperation({
        operation: operation,
      });
    }

    const filename = `${userId}-${Date.now()}.mp4`;
    const filePath = path.join("videos", filename);

    // Create the images directory if it doesn't exist
    fs.mkdirSync("videos", { recursive: true });

    if (!operation.response?.generatedVideos?.length) {
      const filterReason =
        operation.response?.raiMediaFilteredReasons?.[0] ||
        "Video generation failed";
      throw new Error(filterReason);
    }

    // Download the video.
    await ai.files.download({
      file: operation.response.generatedVideos[0].video,
      downloadPath: filePath,
    });

    const uploadResult = await cloudinary.uploader.upload(filePath, {
      resource_type: "video",
    });

    await prisma.project.update({
      where: { id: project.id },
      data: {
        generatedVideo: uploadResult.secure_url,
        isGenerating: false,
      },
    });

    // remove video file from disk after upload
    fs.unlinkSync(filePath);

    res.json({
      message: "Video generation completed",
      videoUrl: uploadResult.secure_url,
    });
  } catch (error: any) {
    const fallbackVideoPath = path.join(
      process.cwd(),
      "..",
      "client",
      "src",
      "assets",
      project?.aspectRatio === "16:9"
        ? "generatedVideo2.mp4"
        : "generatedVideo1.mp4",
    );

    if (fs.existsSync(fallbackVideoPath)) {
      const uploadResult = await cloudinary.uploader.upload(fallbackVideoPath, {
        resource_type: "video",
      });

      await prisma.project.updateMany({
        where: { id: projectId, userId },
        data: {
          generatedVideo: uploadResult.secure_url,
          isGenerating: false,
          error: error.message,
        },
      });

      fallbackVideoUploaded = true;
      Sentry.captureException(error);
      return res.json({
        message: "Video generation fallback used",
        videoUrl: uploadResult.secure_url,
      });
    }

    // update project status and error message
    await prisma.project.updateMany({
      where: { id: projectId, userId },
      data: { isGenerating: false, error: error.message },
    });

    if (isCreditDeducted && !fallbackVideoUploaded) {
      // add credits back
      await prisma.user.update({
        where: { id: userId },
        data: { credits: { increment: 10 } },
      });
    }

    Sentry.captureException(error);
    res.status(500).json({ message: error.message });
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
