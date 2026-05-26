import express from "express";
import {
  createProject,
  deleteProject,
  getAllPublishedProjects,
} from "../controllers/projectController.js";
import { protect } from "../middlewares/auth.js";
import upload from "../configs/multer.js";

const projectRouter = express.Router();

projectRouter.post(
  "/create",
  protect,
  upload.array("images", 2),
  createProject,
);
projectRouter.get("/published", getAllPublishedProjects);
projectRouter.delete("/:projectId", protect, deleteProject);

export default projectRouter;
