import express from "express";
import {
  archiveCampaign,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  getCampaignById,
  getCampaignMeta,
  listCampaigns,
  markCampaignAsSent,
  pauseCampaign,
  resumeCampaign,
  scheduleCampaign,
  updateCampaign,
} from "../controllers/campaignController.js";
import { protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);

router.get("/meta", getCampaignMeta);
router.get("/", listCampaigns);
router.get("/:id", getCampaignById);
router.post("/", createCampaign);
router.post("/:id/duplicate", duplicateCampaign);
router.post("/:id/schedule", scheduleCampaign);
router.post("/:id/pause", pauseCampaign);
router.post("/:id/resume", resumeCampaign);
router.post("/:id/archive", archiveCampaign);
router.post("/:id/mark-sent", markCampaignAsSent);
router.put("/:id", updateCampaign);
router.delete("/:id", deleteCampaign);

export default router;
