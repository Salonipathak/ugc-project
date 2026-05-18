import fs from "fs";
import multer from "multer";
import os from "os";
import path from "path";
const uploadDir = path.join(os.tmpdir(), "ugc-uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        cb(null, `${unique}-${file.originalname}`);
    },
});
const upload = multer({ storage });
export default upload;
