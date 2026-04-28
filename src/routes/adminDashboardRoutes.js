import express from "express";
import {
  getEmailMarketingVendorProfile,
  listEmailMarketingVendors,
  listPlatformOverview,
  listVendorActivity,
  updateVendorStatus,
} from "../controllers/adminDashboardController.js";
import { permitRoles, protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);
router.use(permitRoles("super_admin"));

router.get("/overview", listPlatformOverview);
router.get("/vendors", listEmailMarketingVendors);
router.get("/vendors/:id/profile", getEmailMarketingVendorProfile);
router.get("/vendor-activity", listVendorActivity);
router.patch("/vendors/:id/status", updateVendorStatus);

export default router;
