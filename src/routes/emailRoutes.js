import express from "express";
import {
  sendAdHocTestEmail,
  sendCampaign,
  sendTestEmail,
} from "../controllers/emailController.js";
import { getWebhookEventDebug } from "../controllers/emailEventController.js";
import {
  getOverviewAnalytics,
  getAnalyticsSummary,
  getBounceComplaintBreakdown,
  getCampaignDeliverability,
  getDeliverabilitySummary,
  getRecentEvents,
  getSenderHealthSummary,
  getTopCampaigns,
} from "../controllers/insightsController.js";
import { protectAdmin } from "../middleware/authMiddleware.js";
import {
  createSuppression,
  blockSubscriber,
  listSuppressions,
  suppressSubscriber,
  unsubscribeSubscriber,
  unblockSubscriber,
  unsuppressEntry,
} from "../controllers/suppressionController.js";

const router = express.Router();

router.use(protectAdmin);

router.get("/overview", getOverviewAnalytics);
router.get("/analytics/summary", getAnalyticsSummary);
router.get("/deliverability/summary", getDeliverabilitySummary);
router.get("/deliverability/breakdown", getBounceComplaintBreakdown);
router.get("/deliverability/campaigns", getCampaignDeliverability);
router.get("/deliverability/sender-health", getSenderHealthSummary);
router.get("/events/recent", getRecentEvents);
router.get("/webhook-events", getWebhookEventDebug);
router.get("/campaigns/top", getTopCampaigns);
router.get("/suppressions", listSuppressions);
router.post("/suppressions", createSuppression);
router.post("/suppressions/:id/unsuppress", unsuppressEntry);
router.post("/subscribers/:id/unsubscribe", unsubscribeSubscriber);
router.post("/subscribers/:id/suppress", suppressSubscriber);
router.post("/subscribers/:id/block", blockSubscriber);
router.post("/subscribers/:id/unblock", unblockSubscriber);
router.post("/test-send", sendAdHocTestEmail);
router.post("/campaigns/:id/send-test", sendTestEmail);
router.post("/campaigns/:id/send", sendCampaign);

export default router;
