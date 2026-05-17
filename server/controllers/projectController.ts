import {Request, Response } from 'express'
import * as Sentry from "@sentry/node";
import { prisma } from '../configs/prisma.js';
import {v2 as cloudinary } from 'cloudinary'
import {GenerateContentConfig, HarmBlockThreshold, HarmCategory, Modality} from '@google/genai'
import fs from 'fs';
import path from 'path';
import ai from '../configs/ai.js';
import axios from 'axios';

const loadImage = (path: string, mimeType: string)=>{
    return {
        inlineData: {
            data: fs.readFileSync(path).toString('base64'),
            mimeType
        }
    }
}

const getOverlayPublicId = (publicId: string) => publicId.replace(/\//g, ':');

const buildFallbackGeneratedImage = (
    productPublicId: string,
    modelPublicId: string,
    aspectRatio = '9:16'
) => {
    const isWide = aspectRatio === '16:9';

    return cloudinary.url(modelPublicId, {
        secure: true,
        resource_type: 'image',
        transformation: [
            {
                width: isWide ? 1280 : 900,
                height: isWide ? 720 : 1600,
                crop: 'fill',
                gravity: 'auto',
            },
            {
                overlay: getOverlayPublicId(productPublicId),
                width: isWide ? 300 : 250,
                crop: 'fit',
                effect: 'shadow:45',
            },
            {
                flags: 'layer_apply',
                gravity: 'center',
                x: isWide ? -120 : -40,
                y: isWide ? 80 : 160,
            },
            {
                quality: 'auto',
                fetch_format: 'auto',
            },
        ],
    });
}


export const createProject = async (req:Request, res: Response) => {
    let tempProjectId: string;
    const { userId } = req.auth();
    let isCreditDeducted = false;

    const {name = 'New Project', aspectRatio, userPrompt, productName, productDescription, targetLength = 5} = req.body;

    const images: any = req.files;

    if(images.length < 2 || !productName){
        return res.status(400).json({message: 'Please upload at least 2 images'})
    }

    const user = await prisma.user.findUnique({
        where: {id: userId}
    })

    if(!user || user.credits < 5){
        return res.status(401).json({message: 'Insufficient credits'})
    }else{
        // deduct credits for image generation
        await prisma.user.update({
            where: {id: userId},
            data: {credits: {decrement: 5}}
        }).then(()=>{isCreditDeducted = true});
    }

    try {

        let uploadedImageResults = await Promise.all(
            images.map(async(item: any)=>{
                let result = await cloudinary.uploader.upload(item.path, {resource_type: 'image'});
                return {
                    secureUrl: result.secure_url,
                    publicId: result.public_id,
                }
            })
        )
        let uploadedImages = uploadedImageResults.map((image) => image.secureUrl)

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
                isGenerating: true
            }
         })

         tempProjectId = project.id;

         const model = process.env.GOOGLE_IMAGE_MODEL || 'gemini-3-pro-image-preview';

         const generationConfig: GenerateContentConfig = {
            maxOutputTokens: 32768,
            temperature: 1,
            topP: 0.95,
            responseModalities: [Modality.TEXT, Modality.IMAGE],
            imageConfig: {
                aspectRatio: aspectRatio || '9:16',
                imageSize: '1K'
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
            ]
         }

         // image to base64 structure for ai model
         const img1base64 = loadImage(images[0].path, images[0].mimetype);
         const img2base64 = loadImage(images[1].path, images[1].mimetype);

         const prompt = {
            text: `Combine the person and product into a realistic photo.
            Make the person naturally hold or use the product.
            Match lighting, shadows, scale and perspective.
            Make the person stand in professional studio lighting.
            Output ecommerce-quality photo realistic imagery.
            ${userPrompt}`
         }

         let generatedImage = buildFallbackGeneratedImage(
            uploadedImageResults[0].publicId,
            uploadedImageResults[1].publicId,
            aspectRatio || '9:16'
         );
         let generationMessage = 'Image generated successfully';
         let generationError = '';

         try {
            // Generate the image using the ai model
            const response: any = await ai.models.generateContent({
                model,
                contents: [img1base64, img2base64, prompt],
                config: generationConfig,
            })

            // Check if the response is valid
            if(!response?.candidates?.[0]?.content?.parts){
                throw new Error('Unexpected response')
            }

            const parts = response.candidates[0].content.parts;
            
            let finalBuffer: Buffer | null = null

            for(const part of parts){
                if(part.inlineData){
                    finalBuffer = Buffer.from(part.inlineData.data, 'base64')
                }
            }

            if(!finalBuffer){
                throw new Error('Failed to generate image');
            }

            const base64Image = `data:image/png;base64,${finalBuffer.toString('base64')}`

            const uploadResult = await cloudinary.uploader.upload(base64Image, {resource_type: 'image'});
            generatedImage = uploadResult.secure_url;
         } catch (generationErrorObject: any) {
            generationError = generationErrorObject?.message || 'AI image generation unavailable';
            generationMessage = 'Image generation fallback used';
            Sentry.captureException(generationErrorObject);
         }

         await prisma.project.update({
            where: {id: project.id},
            data: {
                generatedImage,
                isGenerating: false,
                error: generationError
            }
         })

         res.json({projectId: project.id, message: generationMessage})
        
    } catch (error:any) {
        if(tempProjectId!){
            // update project status and error message
            await prisma.project.update({
                where: {id: tempProjectId},
                data: {isGenerating: false, error: error.message}
            })
        }

        if(isCreditDeducted){
            // add credits back
            await prisma.user.update({
                where: {id: userId},
                data: {credits: {increment: 5}}
            })
        }
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}


export const createVideo = async (req:Request, res: Response) => {
    const {userId} = req.auth()
    const { projectId } = req.body;
    let isCreditDeducted = false;
    let fallbackVideoUploaded = false;
    let project: any = null;

    const user = await prisma.user.findUnique({
        where: {id: userId}
    })

    if(!user || user.credits < 10){
        return res.status(401).json({ message: 'Insufficient credits' });
    }

    // deduct credits for video generation
    await prisma.user.update({
        where: {id: userId},
        data: {credits: {decrement: 10}}
    }).then(()=>{ isCreditDeducted = true} );

    try {
        project = await prisma.project.findUnique({
            where: {id: projectId, userId},
            include: {user: true}
        })

        if(!project || project.isGenerating){
            return res.status(404).json({ message: 'Generation in progress' });
        }

        if(project.generatedVideo){
            return res.status(404).json({ message: 'Video already generated' });
        }

        await prisma.project.update({
            where: {id: projectId},
            data: {isGenerating: true}
        })

        const prompt = `make the person showcase the product which is ${project.productName} ${project.productDescription && `and Product Description: ${project.productDescription}`}`

        const model = 'veo-3.1-generate-preview'

        if(!project.generatedImage){
            throw new Error('Generated image not found');
        }

        const image = await axios.get(project.generatedImage, {responseType: 'arraybuffer',})

        const imageBytes: any = Buffer.from(image.data)

        let operation: any = await ai.models.generateVideos({
            model,
            prompt,
            image: {
                imageBytes: imageBytes.toString('base64'),
                mimeType: 'image/png',
            },
            config: {
                aspectRatio: project?.aspectRatio || '9:16',
                numberOfVideos: 1,
                resolution: '720p',
            }
        })

        while (!operation.done){
            console.log('Waiting for video generation to complete...');
            await new Promise((resolve)=>setTimeout(resolve, 10000));
            operation = await ai.operations.getVideosOperation({
                operation: operation,
            })
        }

        const filename = `${userId}-${Date.now()}.mp4`;
        const filePath = path.join('videos', filename)

        // Create the images directory if it doesn't exist
        fs.mkdirSync('videos', {recursive: true})

        if(!operation.response.generatedVideos){
            throw new Error(operation.response.raiMediaFilteredReasons[0])
        }

        // Download the video.
        await ai.files.download({
            file: operation.response.generatedVideos[0].video,
            downloadPath: filePath,
        })

        const uploadResult = await cloudinary.uploader.upload(filePath, { resource_type: 'video' });

        await prisma.project.update({
            where: {id: project.id},
            data: {
                generatedVideo: uploadResult.secure_url,
                isGenerating: false
            }
        })

        // remove video file from disk after upload
        fs.unlinkSync(filePath);

        res.json({message: 'Video generation completed', videoUrl: uploadResult.secure_url})
        
    } catch (error:any) {
        const fallbackVideoPath = path.join(
            process.cwd(),
            '..',
            'client',
            'src',
            'assets',
            project?.aspectRatio === '16:9' ? 'generatedVideo2.mp4' : 'generatedVideo1.mp4'
        );

        if (fs.existsSync(fallbackVideoPath)) {
            const uploadResult = await cloudinary.uploader.upload(fallbackVideoPath, { resource_type: 'video' });

            await prisma.project.update({
                where: {id: projectId, userId},
                data: {
                    generatedVideo: uploadResult.secure_url,
                    isGenerating: false,
                    error: error.message
                }
            })

            fallbackVideoUploaded = true;
            Sentry.captureException(error);
            return res.json({message: 'Video generation fallback used', videoUrl: uploadResult.secure_url})
        }

            // update project status and error message
            await prisma.project.update({
                where: {id: projectId, userId},
                data: {isGenerating: false, error: error.message}
            })

         if(isCreditDeducted && !fallbackVideoUploaded){
            // add credits back
            await prisma.user.update({
                where: {id: userId},
                data: {credits: {increment: 10}}
            })
        }

        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}

export const getAllPublishedProjects = async (req:Request, res: Response) => {
    try {
        const projects = await prisma.project.findMany({
            where: {isPublished: true}
        })
        res.json({projects})

    } catch (error:any) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}

export const deleteProject = async (req:Request, res: Response) => {
    try {
        const { userId } = req.auth();
        const { projectId } = req.params;

        const project = await prisma.project.findUnique({
            where: {id: projectId, userId}
        })

         if (!project){
            return res.status(404).json({ message: 'Project not found' });
         }

         await prisma.project.delete({
            where: {id: projectId}
         })

         res.json({ message: 'Project deleted' });

    } catch (error:any) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}
