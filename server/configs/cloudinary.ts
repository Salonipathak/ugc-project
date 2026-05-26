import './env.js';
import { v2 as cloudinary } from 'cloudinary';

if (process.env.CLOUDINARY_URL) {
    cloudinary.config({ secure: true });
}

export { cloudinary };
