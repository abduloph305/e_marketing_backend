import CampaignRecipient from "../models/CampaignRecipient.js";
import { storeEmailEvent } from "./emailEventService.js";

const inferDeviceType = (userAgent = "") => {
  const value = userAgent.toLowerCase();

  if (!value) return "";
  if (value.includes("mobile")) return "mobile";
  if (value.includes("tablet") || value.includes("ipad")) return "tablet";
  return "desktop";
};

const normalizeSnsBody = (body) =>
  body.Type === "Notification" && body.Message ? JSON.parse(body.Message) : body;

const resolveEventType = (payload) => {
  const notificationType = (payload.eventType || payload.notificationType || "").toLowerCase();

  const eventTypeMap = {
    send: "send",
    delivery: "delivery",
    open: "open",
    click: "click",
    bounce: "bounce",
    complaint: "complaint",
    reject: "reject",
    deliverydelay: "delivery_delay",
    delivery_delay: "delivery_delay",
    renderingfailure: "rendering_failure",
    rendering_failure: "rendering_failure",
    unsubscribe: "unsubscribe",
  };

  return eventTypeMap[notificationType] || "";
};

const normalizeSesEventPayload = async (body) => {
  const payload = normalizeSnsBody(body);
  const eventType = resolveEventType(payload);
  const mail = payload.mail || {};
  const tags = mail.tags || {};
  const messageId = mail.messageId || `ses-${Date.now()}`;
  const recipientEmail =
    mail.destination?.[0] ||
    payload.delivery?.recipients?.[0] ||
    payload.bounce?.bouncedRecipients?.[0]?.emailAddress ||
    payload.complaint?.complainedRecipients?.[0]?.emailAddress ||
    payload.click?.linkTags?.recipientEmail?.[0] ||
    "";

  let campaignId = tags.campaignId?.[0] || null;
  let subscriberId = tags.subscriberId?.[0] || null;

  if ((!campaignId || !subscriberId) && messageId) {
    const recipient = await CampaignRecipient.findOne({ messageId })
      .select("campaignId subscriberId email")
      .lean();

    if (recipient) {
      campaignId = campaignId || recipient.campaignId || null;
      subscriberId = subscriberId || recipient.subscriberId || null;
    }
  }

  const openData = payload.open || {};
  const clickData = payload.click || {};

  return {
    campaignId,
    subscriberId,
    recipientEmail: recipientEmail.toLowerCase(),
    messageId,
    eventType,
    timestamp:
      payload[eventType]?.timestamp ||
      payload.deliveryDelay?.timestamp ||
      payload.renderingFailure?.timestamp ||
      mail.timestamp ||
      new Date().toISOString(),
    rawPayload: payload,
    bounceType: payload.bounce?.bounceType || "",
    bounceSubType: payload.bounce?.bounceSubType || "",
    complaintFeedbackType: payload.complaint?.complaintFeedbackType || "",
    clickedLink: clickData.link || clickData.linkUrl || clickData.url || "",
    ipAddress: openData.ipAddress || clickData.ipAddress || "",
    userAgent: openData.userAgent || clickData.userAgent || "",
    deviceType: inferDeviceType(openData.userAgent || clickData.userAgent || ""),
    geo: openData.geoLocation || clickData.geoLocation || null,
  };
};

const processSesEventPayload = async (body) => {
  const normalized = await normalizeSesEventPayload(body);

  if (!normalized.eventType || !normalized.recipientEmail) {
    throw new Error("Unsupported SES event payload");
  }

  const event = await storeEmailEvent({
    campaignId: normalized.campaignId,
    subscriberId: normalized.subscriberId,
    recipientEmail: normalized.recipientEmail,
    messageId: normalized.messageId,
    eventType: normalized.eventType,
    timestamp: new Date(normalized.timestamp),
    rawPayload: normalized.rawPayload,
    bounceType: normalized.bounceType,
    bounceSubType: normalized.bounceSubType,
    complaintFeedbackType: normalized.complaintFeedbackType,
    clickedLink: normalized.clickedLink,
    ipAddress: normalized.ipAddress,
    userAgent: normalized.userAgent,
    deviceType: normalized.deviceType,
    geo: normalized.geo,
  });

  return { event, normalized };
};

export { normalizeSesEventPayload, processSesEventPayload };
