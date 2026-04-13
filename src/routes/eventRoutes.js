import express from "express";
import { ingestSesEvent, trackClick, trackOpen } from "../controllers/emailEventController.js";

const router = express.Router();

router.post("/ses", ingestSesEvent);
router.get("/track/open/:recipientId.gif", trackOpen);
router.get("/track/click/:recipientId", trackClick);

export default router;
