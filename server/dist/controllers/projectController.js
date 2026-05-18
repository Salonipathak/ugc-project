import * as Sentry from "@sentry/node";
import { prisma } from "../configs/prisma.js";
import { v2 as cloudinary } from "cloudinary";
import { HarmBlockThreshold, HarmCategory, Modality, } from "@google/genai";
import fs from "fs";
import path from "path";
import ai from "../configs/ai.js";
import axios from "axios";
const loadImage = (path, mimeType) => {
    return {
        inlineData: {
            data: fs.readFileSync(path).toString("base64"),
            mimeType,
        },
    };
};
const getOverlayPublicId = (publicId) => publicId.replace(/\//g, ":");
const buildFallbackGeneratedImage = (productPublicId, modelPublicId, aspectRatio = "9:16") => {
    const isWide = aspectRatio === "16:9";
    return cloudinary.url(modelPublicId, {
        secure: true,
        resource_type: "image",
        transformation: [
            {
                width: isWide ? 1280 : 900,
                height: isWide ? 720 : 1600,
                crop: "fill",
                gravity: "auto",
            },
            {
                overlay: getOverlayPublicId(productPublicId),
                width: isWide ? 200 : 160,
                crop: "fit",
                effect: "shadow:35",
            },
            {
                flags: "layer_apply",
                gravity: "south_east",
                x: 30,
                y: 80,
            },
            {
                quality: "auto",
                fetch_format: "auto",
            },
        ],
    });
};
const isBeautyOrSkincareProduct = (productName, productDescription) => {
    const text = `${productName} ${productDescription || ""}`.toLowerCase();
    return /sunscreen|spf|serum|skincare|skin science|moistur|cream|lotion|cleanser|toner|beauty|cosmetic|minimalist|face fluid|pa\+/i.test(text);
};
const buildImageGenerationPrompt = ({ productName, productDescription, userPrompt, aspectRatio = "9:16", }) => {
    const formatHint = aspectRatio === "16:9"
        ? "horizontal campaign frame (YouTube, web banners)"
        : "vertical mobile-first frame (Reels, TikTok, Stories)";
    const productContext = productDescription?.trim()
        ? `\nPRODUCT DETAILS: ${productDescription.trim()}`
        : "";
    const creativeDirection = userPrompt?.trim()
        ? `\n\nCLIENT CREATIVE DIRECTION (highest priority — follow closely):\n${userPrompt.trim()}`
        : "";
    const beautyScene = isBeautyOrSkincareProduct(productName, productDescription)
        ? `
BEAUTY / SKINCARE CAMPAIGN (apply for this product):
• Scene: bright, clean beauty studio — soft white/cream backdrop, subtle warm fill light, spa-meets-DTC aesthetic (think Sephora or Glossier campaign, not catalog collage)
• Pose: model holds ONLY the squeeze tube in one hand near cheek or jawline; other hand may gently touch face as if about to apply; face fully visible and flattering
• Show the tube label clearly to camera; do NOT include the cardboard retail box from the packshot
• Skin should look healthy, dewy, natural — sunscreen/skincare trust and glow
• Wardrobe: if model wears traditional or formal attire, soften with elegant styling OR reframe as upper-body beauty shot focused on face + product`
        : "";
    return `TASK: Generate ONE brand-new, photorealistic marketing photograph. You are compositing two reference inputs into a single professional campaign image shot on location — NOT stacking, NOT overlaying, NOT pasting one image on top of another.

INPUT HANDLING (critical — read before generating):
• REFERENCE A (product packshot): Often a flat e-commerce photo on pure white with box + tube. You MUST isolate the actual product packaging (usually the tube/bottle) and place it naturally in the model's hand or beside them. Completely discard the white catalog background, rectangular crop, and cardboard box unless it adds real value in-hand.
• REFERENCE B (model portrait): Often shot on solid black or studio backdrop. Preserve the person's exact face, features, hair, skin tone, and jewelry. Replace the black/isolated backdrop with a new cohesive environment that matches the product category.

PRODUCT: ${productName}${productContext}
OUTPUT FORMAT: ${aspectRatio} (${formatHint})
${beautyScene}

CREATIVE GOAL:
A scroll-stopping paid-social ad where the model authentically presents this product — as if a professional photographer directed a real shoot with the same talent and the same SKU on set. The viewer must never suspect two source photos were merged.

COMPOSITION:
• Model's face and eyes fully visible — never blocked, never covered by product graphics
• Product in foreground at hand/chest height, label readable, realistic scale (tube fits naturally in one hand)
• Three-quarter or straight-on portrait framing; waist-up or chest-up for beauty products
• Rule of thirds; clean negative space for ad copy if needed

LIGHTING & INTEGRATION (non-negotiable):
• One unified light source — same color temperature, shadow direction, and intensity on skin, hair, clothing, and product
• Contact shadows where fingers grip the tube; subtle reflections on packaging material
• Depth of field: sharp on face + product, gentle bokeh on background
• No halos, no white fringes, no rectangular paste boundaries, no floating product square

MOOD: Premium, trustworthy, aspirational but relatable — high-converting DTC / influencer UGC.

ABSOLUTE FAILURES TO AVOID (these will be rejected):
✗ Placing the entire product packshot (white box + tube on white rectangle) over the model's face or torso
✗ Centering a catalog image on top of the portrait like a sticker
✗ Keeping the model on pure black while product floats separately
✗ Cartoon, illustration, CGI, or plastic skin
✗ Distorting face, changing ethnicity, or altering product branding

OUTPUT: Single cohesive photograph only. Photorealistic. Campaign-ready.${creativeDirection}`;
};
const buildVideoGenerationPrompt = ({ productName, productDescription, userPrompt, aspectRatio = "9:16", }) => {
    const productContext = productDescription?.trim()
        ? ` ${productDescription.trim()}`
        : "";
    const creativeDirection = userPrompt?.trim()
        ? ` Creative direction: ${userPrompt.trim()}.`
        : "";
    return `Cinematic ${aspectRatio} UGC product video. The same person from the reference image enthusiastically presents "${productName}" — ${productContext.trim() || "a premium consumer product"}.

Action: natural micro-movements — subtle head turn, genuine smile, hands adjusting product toward camera, soft showcase gestures like a top TikTok/Instagram creator filming at home or in a clean studio. Product label stays visible; lighting stays consistent with the reference frame.

Mood: authentic, trustworthy, high-energy but believable — paid-social ad that feels organic, not over-produced.${creativeDirection}

Camera: stable handheld UGC feel with gentle movement. No morphing faces, no scene cuts, no on-screen text. Photorealistic motion only.`;
};
export const createProject = async (req, res) => {
    let tempProjectId;
    const { userId } = req.auth();
    let isCreditDeducted = false;
    const { name = "New Project", aspectRatio, userPrompt, productName, productDescription, targetLength = 5, } = req.body;
    const images = req.files;
    if (!Array.isArray(images) || images.length < 2 || !productName) {
        return res.status(400).json({ message: "Please upload at least 2 images" });
    }
    const user = await prisma.user.findUnique({
        where: { id: userId },
    });
    if (!user || user.credits < 5) {
        return res.status(401).json({ message: "Insufficient credits" });
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
            let result = await cloudinary.uploader.upload(item.path, {
                resource_type: "image",
            });
            try {
                fs.unlinkSync(item.path);
            }
            catch {
                // ignore cleanup errors
            }
            return {
                secureUrl: result.secure_url,
                publicId: result.public_id,
            };
        }));
        let uploadedImages = uploadedImageResults.map((image) => image.secureUrl);
        const project = await prisma.project.create({
            data: {
                name,
                userId,
                productName,
                productDescription,
                userPrompt,
                aspectRatio,
                targetLength: parseInt(targetLength),
                uploadedImages,
                isGenerating: true,
            },
        });
        tempProjectId = project.id;
        const model = process.env.GOOGLE_IMAGE_MODEL || "gemini-3-pro-image-preview";
        const generationConfig = {
            maxOutputTokens: 32768,
            temperature: 0.85,
            topP: 0.9,
            responseModalities: [Modality.TEXT, Modality.IMAGE],
            imageConfig: {
                aspectRatio: aspectRatio || "9:16",
                imageSize: "1K",
            },
            safetySettings: [
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.OFF,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.OFF,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.OFF,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.OFF,
                },
            ],
        };
        // image to base64 structure for ai model
        const img1base64 = loadImage(images[0].path, images[0].mimetype);
        const img2base64 = loadImage(images[1].path, images[1].mimetype);
        const promptText = buildImageGenerationPrompt({
            productName,
            productDescription,
            userPrompt,
            aspectRatio: aspectRatio || "9:16",
        });
        const contents = [
            {
                text: `REFERENCE A — PRODUCT PACKSHOT (first image below):
The product photo may include a white studio background, retail box, and tube/bottle together. In your output, use only the real product packaging (e.g. the tube) held naturally by the model — never paste this entire rectangular image as a flat layer.`,
            },
            img1base64,
            {
                text: `REFERENCE B — MODEL / PERSON (second image below):
Preserve this exact person's face, identity, hair, skin, and styling. If the background is solid black or a cutout, replace it with a new professional scene — do not keep the black backdrop.`,
            },
            img2base64,
            { text: promptText },
        ];
        let generatedImage = buildFallbackGeneratedImage(uploadedImageResults[0].publicId, uploadedImageResults[1].publicId, aspectRatio || "9:16");
        let generationMessage = "Image generated successfully";
        let generationError = "";
        try {
            // Generate the image using the ai model
            const response = await ai.models.generateContent({
                model,
                contents,
                config: generationConfig,
            });
            // Check if the response is valid
            if (!response?.candidates?.[0]?.content?.parts) {
                throw new Error("Unexpected response");
            }
            const parts = response.candidates[0].content.parts;
            let finalBuffer = null;
            for (const part of parts) {
                if (part.inlineData) {
                    finalBuffer = Buffer.from(part.inlineData.data, "base64");
                }
            }
            if (!finalBuffer) {
                throw new Error("Failed to generate image");
            }
            const base64Image = `data:image/png;base64,${finalBuffer.toString("base64")}`;
            const uploadResult = await cloudinary.uploader.upload(base64Image, {
                resource_type: "image",
            });
            generatedImage = uploadResult.secure_url;
        }
        catch (generationErrorObject) {
            generationError =
                generationErrorObject?.message || "AI image generation unavailable";
            generationMessage =
                "AI compositing unavailable — basic preview used. Retry for full campaign quality.";
            Sentry.captureException(generationErrorObject);
        }
        await prisma.project.update({
            where: { id: project.id },
            data: {
                generatedImage,
                isGenerating: false,
                error: generationError,
            },
        });
        res.json({ projectId: project.id, message: generationMessage });
    }
    catch (error) {
        if (tempProjectId) {
            // update project status and error message
            await prisma.project.update({
                where: { id: tempProjectId },
                data: { isGenerating: false, error: error.message },
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
        res.status(500).json({ message: error.message });
    }
};
export const createVideo = async (req, res) => {
    const { userId } = req.auth();
    const { projectId } = req.body;
    let isCreditDeducted = false;
    let fallbackVideoUploaded = false;
    let project = null;
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
        const imageBytes = Buffer.from(image.data);
        let operation = await ai.models.generateVideos({
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
            const filterReason = operation.response?.raiMediaFilteredReasons?.[0] ||
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
    }
    catch (error) {
        const fallbackVideoPath = path.join(process.cwd(), "..", "client", "src", "assets", project?.aspectRatio === "16:9"
            ? "generatedVideo2.mp4"
            : "generatedVideo1.mp4");
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
export const getAllPublishedProjects = async (req, res) => {
    try {
        const projects = await prisma.project.findMany({
            where: { isPublished: true },
        });
        res.json({ projects });
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
