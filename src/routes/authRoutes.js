import express from "express";
import {
  loginAdmin,
  logoutAdmin,
  getCurrentAdmin,
} from "../controllers/authController.js";
import { protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("/login", loginAdmin);
router.post("/logout", protectAdmin, logoutAdmin);
router.get("/me", protectAdmin, getCurrentAdmin);

export default router;
