import express from "express";
import {
  deactivateTeamUser,
  listTeamUsers,
  saveTeamUser,
  updateTeamUser,
} from "../controllers/teamController.js";
import { protectAdmin, requirePermission } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);
router.use(requirePermission("manage_team_access"));

router.get("/", listTeamUsers);
router.post("/", saveTeamUser);
router.patch("/:id", updateTeamUser);
router.delete("/:id", deactivateTeamUser);

export default router;
