import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailEvent from "../models/EmailEvent.js";
import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { storeEmailEvent } from "../services/emailEventService.js";
import { env } from "../config/env.js";
import { processSesEventPayload } from "../services/sesEventProcessorService.js";
import { inferDeviceType } from "../utils/device.js";

const transparentGif = Buffer.from(
  "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

const recordTrackedEvent = async (recipientId, eventType, extra = {}) => {
  const recipient = await CampaignRecipient.findById(recipientId).lean();

  if (!recipient) {
    return null;
  }

  const event = await storeEmailEvent({
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
    deviceType: extra.deviceType || inferDeviceType(extra.userAgent),
    geo: extra.geo || null,
  });

  return { event, recipient };
};

const appendQueryParams = (baseUrl, params = {}) => {
  const url = String(baseUrl || "");
  const entries = Object.entries(params).filter(([, value]) => String(value || "").trim());

  if (!entries.length) {
    return url;
  }

  try {
    const parsedUrl = new URL(url);
    entries.forEach(([key, value]) => {
      if (!parsedUrl.searchParams.has(key)) {
        parsedUrl.searchParams.set(key, String(value));
      }
    });
    return parsedUrl.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}${entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&")}`;
  }
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

  const tracked = await recordTrackedEvent(req.params.recipientId, "click", {
    clickedLink: String(targetUrl),
    blockId: req.query.blockId || "",
    section: req.query.section || "",
    ctaType: req.query.ctaType || "",
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"] || "",
  });

  const attributedTargetUrl = tracked?.recipient
    ? appendQueryParams(targetUrl, {
        sl_campaign_id: tracked.recipient.campaignId,
        sl_recipient_id: tracked.recipient._id,
        sl_subscriber_id: tracked.recipient.subscriberId,
        utm_source: "sellerslogin_email",
        utm_medium: "email",
        utm_campaign: tracked.recipient.campaignId,
      })
    : String(targetUrl);

  return res.redirect(attributedTargetUrl);
};

const ingestSesEvent = async (req, res) => {
  console.log("[ses:webhook] hit", {
    method: req.method,
    path: req.originalUrl,
    contentType: req.headers["content-type"] || "",
    bodyType: req.body?.Type || req.body?.type || req.body?.["detail-type"] || "",
    source: req.body?.source || req.body?.Source || "",
  });

  if (env.sesWebhookSecret) {
    const secret = req.headers["x-webhook-secret"];
    if (secret !== env.sesWebhookSecret) {
      console.warn("[ses:webhook] rejected invalid secret");
      return res.status(401).json({ message: "Invalid webhook secret" });
    }
  }

  if (req.body.Type === "SubscriptionConfirmation") {
    console.log("[ses:webhook] subscription confirmation received");
    return res.json({ message: "Subscription confirmation received" });
  }

  try {
    const { normalized } = await processSesEventPayload(req.body);

    console.log("[ses:webhook] processed event", {
      eventType: normalized.eventType,
      messageId: normalized.messageId,
      recipientEmail: normalized.recipientEmail,
    });

    return res.json({
      message: "Event stored",
      eventType: normalized.eventType,
      messageId: normalized.messageId,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unsupported SES event payload" });
  }
};

const getWebhookEventDebug = async (_req, res) => {
  const [events, suppressions] = await Promise.all([
    EmailEvent.find({
      eventType: { $in: ["bounce", "complaint", "reject"] },
    })
      .sort({ timestamp: -1 })
      .limit(25)
      .populate({ path: "campaignId", select: "name status" })
      .lean(),
    SuppressionEntry.find({
      reason: { $in: ["bounce", "complaint", "reject"] },
    })
      .sort({ updatedAt: -1 })
      .limit(25)
      .lean(),
  ]);

  const normalizedEvents = await Promise.all(
    events.map(async (event) => {
      const subscriber = await Subscriber.findOne({ email: event.recipientEmail })
        .select("status blockedReason blockedAt")
        .lean();

      return {
        ...event,
        subscriber: subscriber || null,
      };
    }),
  );

  return res.json({
    recentWebhookEvents: normalizedEvents,
    recentSuppressions: suppressions,
    counts: {
      bounce: normalizedEvents.filter((event) => event.eventType === "bounce").length,
      complaint: normalizedEvents.filter((event) => event.eventType === "complaint").length,
      reject: normalizedEvents.filter((event) => event.eventType === "reject").length,
    },
  });
};

export { getWebhookEventDebug, ingestSesEvent, trackClick, trackOpen };
