import "./configs/instrument.mjs"
import express, { Request, Response } from 'express';
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { clerkMiddleware } from '@clerk/express'
import clerkWebhooks from './controllers/clerk.js';
import * as Sentry from "@sentry/node"
import userRouter from "./routes/userRoutes.js";
import projectRouter from "./routes/projectRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors())
app.use((req, res, next) => {
    res.setHeader('X-UGC-Backend-Version', 'tensorart-default-config-v2');
    next();
})

app.post(
  "/api/clerk",
  express.raw({ type: "application/json" }),
  clerkWebhooks,
);

app.use(express.json());
app.use(clerkMiddleware());

app.get("/", (req: Request, res: Response) => {
  res.send("Server is Live!");
});
app.get("/debug-sentry", function mainHandler(req, res) {
  throw new Error("My first Sentry error!");
});
app.use('/api/user', userRouter)
app.use('/api/project', projectRouter)

app.use((error: any, req: Request, res: Response, next: any) => {
    Sentry.captureException(error);
    res.status(error?.status || error?.statusCode || 500).json({
        message: error?.message || 'Internal server error',
    });
})

// The error handler must be registered before any other error middleware and after all controllers
Sentry.setupExpressErrorHandler(app);
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

