import express from "express";
import { ingestOphmateEvent } from "../controllers/integrationController.js";

const router = express.Router();

router.post("/ophmate/events", ingestOphmateEvent);

export default router;
