import CampaignRecipient from "../models/CampaignRecipient.js";
import { storeEmailEvent } from "../services/emailEventService.js";
import { env } from "../config/env.js";
import { processSesEventPayload } from "../services/sesEventProcessorService.js";

const transparentGif = Buffer.from(
  "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

const recordTrackedEvent = async (recipientId, eventType, extra = {}) => {
  const recipient = await CampaignRecipient.findById(recipientId).lean();

  if (!recipient) {
    return null;
  }

  return storeEmailEvent({
    campaignId: recipient.campaignId,
    subscriberId: recipient.subscriberId,
    recipientEmail: recipient.email,
    messageId: recipient.messageId || `recipient-${recipient._id}`,
    eventType,
    timestamp: new Date(),
    rawPayload: {
      source: "dashboard-tracking",
      ...extra,
    },
    clickedLink: extra.clickedLink || "",
    blockId: extra.blockId || "",
    section: extra.section || "",
    ctaType: extra.ctaType || "",
    ipAddress: extra.ipAddress || "",
    userAgent: extra.userAgent || "",
    deviceType: extra.deviceType || "",
    geo: extra.geo || null,
  });
};

const trackOpen = async (req, res) => {
  await recordTrackedEvent(req.params.recipientId, "open", {
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"] || "",
  });

  res.set({
    "Content-Type": "image/gif",
    "Content-Length": transparentGif.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });

  return res.end(transparentGif);
};

const trackClick = async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ message: "Missing target URL" });
  }

  await recordTrackedEvent(req.params.recipientId, "click", {
    clickedLink: String(targetUrl),
    blockId: req.query.blockId || "",
    section: req.query.section || "",
    ctaType: req.query.ctaType || "",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"] || "",
  });

  return res.redirect(String(targetUrl));
};

const ingestSesEvent = async (req, res) => {
  if (env.sesWebhookSecret) {
    const secret = req.headers["x-webhook-secret"];
    if (secret !== env.sesWebhookSecret) {
      return res.status(401).json({ message: "Invalid webhook secret" });
    }
  }

  if (req.body.Type === "SubscriptionConfirmation") {
    return res.json({ message: "Subscription confirmation received" });
  }

  try {
    const { normalized } = await processSesEventPayload(req.body);

    return res.json({
      message: "Event stored",
      eventType: normalized.eventType,
      messageId: normalized.messageId,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unsupported SES event payload" });
  }
};

export { ingestSesEvent, trackClick, trackOpen };
