import express from "express";
import { exportReports, getReportsOverview } from "../controllers/reportController.js";
import { protectAdmin, requirePermission } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);

router.get("/", requirePermission("view_reports"), getReportsOverview);
router.get("/export", requirePermission("export_reports"), exportReports);

export default router;
