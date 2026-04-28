import express from "express";
import {
  listAdminNotifications,
  markAdminNotificationsRead,
} from "../controllers/adminNotificationController.js";
import { permitRoles, protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);
router.use(permitRoles("super_admin"));

router.get("/", listAdminNotifications);
router.patch("/read-all", markAdminNotificationsRead);

export default router;
