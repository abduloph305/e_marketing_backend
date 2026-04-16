import express from "express";
import { ingestOphmateEvent } from "../controllers/integrationController.js";

const router = express.Router();

router.post("/ophmate/events", ingestOphmateEvent);
router.post("/website/events", ingestOphmateEvent);
router.post("/marketing/events", ingestOphmateEvent);

export default router;
