import express from "express";
import {
  ingestSesEvent,
  trackAutomationClick,
  trackAutomationOpen,
  trackClick,
  trackOpen,
} from "../controllers/emailEventController.js";

const router = express.Router();

router.post("/ses", ingestSesEvent);
router.get("/track/open/:recipientId.gif", trackOpen);
router.get("/track/click/:recipientId", trackClick);
router.get("/track/automation/open/:eventId.gif", trackAutomationOpen);
router.get("/track/automation/click/:eventId", trackAutomationClick);

export default router;
