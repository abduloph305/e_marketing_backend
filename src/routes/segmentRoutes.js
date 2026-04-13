import express from "express";
import {
  listSegments,
  getSegmentById,
  getSegmentMeta,
  createSegment,
  updateSegment,
  deleteSegment,
  previewSegment,
} from "../controllers/segmentController.js";
import { protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);

router.get("/meta", getSegmentMeta);
router.get("/", listSegments);
router.post("/", createSegment);
router.post("/preview", previewSegment);
router.get("/:id", getSegmentById);
router.put("/:id", updateSegment);
router.delete("/:id", deleteSegment);

export default router;
