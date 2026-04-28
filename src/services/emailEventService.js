import EmailEvent from "../models/EmailEvent.js";
import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import {
  logCampaignActivity,
  updateCampaignCounters,
  updateCampaignRecipientStatus,
} from "./campaignService.js";

const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();

const subscriberStatusMap = {
  bounce: "bounced",
  complaint: "blocked",
  reject: "suppressed",
  unsubscribe: "unsubscribed",
};

const singularEventTypes = new Set([
  "send",
  "delivery",
  "bounce",
  "complaint",
  "reject",
  "delivery_delay",
  "rendering_failure",
  "unsubscribe",
]);

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const getDayAge = (timestamp, referenceDate = new Date()) => {
  if (!timestamp) {
    return null;
  }

  const value = new Date(timestamp);
  const difference = referenceDate.getTime() - value.getTime();

  if (Number.isNaN(value.getTime()) || difference < 0) {
    return 0;
  }

  return Math.floor(difference / DAY_IN_MS);
};

const recencyBonus = (ageDays, weights) => {
  if (ageDays === null) {
    return 0;
  }

  const [fresh, warm, cool, stale] = weights;

  if (ageDays <= 7) return fresh;
  if (ageDays <= 30) return warm;
  if (ageDays <= 90) return cool;
  return stale;
};

const shouldCreateSuppression = ({ eventType }) =>
  eventType === "bounce" ||
  eventType === "complaint" ||
  eventType === "reject" ||
  eventType === "unsubscribe";

const resolveSuppressionReason = (eventType) => {
  if (eventType === "complaint") return "complaint";
  if (eventType === "bounce") return "bounce";
  if (eventType === "reject") return "reject";
  if (eventType === "unsubscribe") return "unsubscribe";
  return "manual";
};

const resolveSubscriberUpdateForEvent = (subscriber = {}, eventType, timestamp) => {
  if (!subscriber?._id) {
    return null;
  }

  const currentStatus = String(subscriber.status || "").toLowerCase();
  const currentBlockedReason = String(subscriber.blockedReason || "").toLowerCase();

  if (currentStatus === "blocked" && currentBlockedReason === "spam" && eventType !== "complaint") {
    return null;
  }

  if (eventType === "complaint") {
    return {
      status: "blocked",
      blockedReason: "spam",
      blockedAt: timestamp,
    };
  }

  if (eventType === "bounce") {
    return {
      status: "bounced",
      blockedReason: "",
      blockedAt: null,
    };
  }

  if (eventType === "reject") {
    return {
      status: "suppressed",
      blockedReason: "",
      blockedAt: null,
    };
  }

  if (eventType === "unsubscribe") {
    return {
      status: "unsubscribed",
      blockedReason: "",
      blockedAt: null,
    };
  }

  return null;
};

const upsertSuppressionFromEvent = async ({
  recipientEmail,
  campaignId,
  subscriberId,
  eventType,
  timestamp,
  vendorId = "",
}) => {
  if (!["bounce", "complaint", "reject", "unsubscribe"].includes(eventType)) {
    return null;
  }

  const suppression = await SuppressionEntry.findOneAndUpdate(
    { vendorId, email: recipientEmail },
    {
      vendorId,
      email: recipientEmail,
      reason: resolveSuppressionReason(eventType),
      source: "ses",
      status: "active",
      relatedCampaignId: campaignId,
      relatedSubscriberId: subscriberId,
      updatedAt: timestamp,
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  );

  console.log(
    `[audience] suppression updated for ${recipientEmail} (${suppression.reason})`,
  );

  return suppression;
};

const recalculateEngagementScore = (subscriber = {}, referenceDate = new Date()) => {
  const lastActivityAge = getDayAge(subscriber.lastActivityAt, referenceDate);
  const lastOpenAge = getDayAge(subscriber.lastOpenAt, referenceDate);
  const lastClickAge = getDayAge(subscriber.lastClickAt, referenceDate);
  const lastOrderAge = getDayAge(subscriber.lastOrderDate, referenceDate);

  const commerceScore =
    Number(subscriber.totalOrders || 0) * 18 + Number(subscriber.totalSpent || 0) * 0.08;

  const engagementScore =
    commerceScore +
    recencyBonus(lastOpenAge, [14, 10, 5, 0]) +
    recencyBonus(lastClickAge, [22, 14, 7, 0]) +
    recencyBonus(lastActivityAge, [8, 5, 2, 0]) +
    recencyBonus(lastOrderAge, [12, 8, 4, 0]) -
    (lastActivityAge !== null && lastActivityAge > 30 ? Math.min(20, Math.floor((lastActivityAge - 30) / 10) * 2) : 0) -
    (subscriber.status === "unsubscribed" ? 20 : 0) -
    (subscriber.status === "blocked" || subscriber.status === "complained" ? 35 : 0);

  return Math.min(100, Math.max(0, Math.round(engagementScore)));
};

const updateSubscriberFromEmailEvent = async ({ subscriber, eventType, timestamp, recipientEmail }) => {
  const nextSubscriberUpdate = resolveSubscriberUpdateForEvent(subscriber, eventType, timestamp);

  if (!nextSubscriberUpdate) {
    return null;
  }

  const updatedSubscriber = await Subscriber.findByIdAndUpdate(
    subscriber._id,
    nextSubscriberUpdate,
    { returnDocument: "after", runValidators: true },
  );

  console.log(
    `[audience] subscriber updated ${recipientEmail} -> ${updatedSubscriber.status}`,
  );

  return updatedSubscriber;
};

const updateSubscriberActivity = async (recipientEmail, eventType, timestamp, vendorId = "") => {
  const subscriber = await Subscriber.findOne({ vendorId, email: recipientEmail }).lean();

  if (!subscriber) {
    return;
  }

  const nextState = {
    lastActivityAt: timestamp,
  };

  if (eventType === "send" || eventType === "delivery") {
    nextState.lastEmailSentAt = timestamp;
  }

  if (eventType === "open") {
    nextState.lastOpenAt = timestamp;
  }

  if (eventType === "click") {
    nextState.lastClickAt = timestamp;
  }

  if (["send", "delivery", "open", "click"].includes(eventType)) {
    const merged = {
      ...subscriber,
      ...nextState,
    };

    nextState.engagementScore = recalculateEngagementScore(merged, timestamp);
  }

  await Subscriber.findByIdAndUpdate(subscriber._id, {
    $set: nextState,
  });
};

const storeEmailEvent = async ({
  campaignId = null,
  subscriberId = null,
  vendorId = "",
  recipientEmail,
  messageId,
  eventType,
  timestamp,
  rawPayload = null,
  bounceType = "",
  bounceSubType = "",
  complaintFeedbackType = "",
  clickedLink = "",
  blockId = "",
  section = "",
  ctaType = "",
  ipAddress = "",
  userAgent = "",
  deviceType = "",
  geo = null,
}) => {
  let normalizedEmail = "";

  try {
    normalizedEmail = normalizeEmail(recipientEmail);

    if (singularEventTypes.has(eventType)) {
      const existingEvent = await EmailEvent.findOne({
        vendorId,
        messageId,
        recipientEmail: normalizedEmail,
        eventType,
      });

      if (existingEvent) {
        return existingEvent;
      }
    }

    const event = await EmailEvent.create({
      vendorId,
      campaignId,
      subscriberId,
      recipientEmail: normalizedEmail,
      messageId,
      eventType,
      timestamp,
      rawPayload,
      bounceType,
      bounceSubType,
      complaintFeedbackType,
      clickedLink,
      blockId,
      section,
      ctaType,
      ipAddress,
      userAgent,
      deviceType,
      geo,
    });

    await updateCampaignRecipientStatus({
      campaignId,
      subscriberId,
      recipientEmail: normalizedEmail,
      messageId,
      eventType,
      timestamp,
      vendorId,
    });

    const currentSubscriber = await Subscriber.findOne({ vendorId, email: normalizedEmail }).select(
      "status blockedReason blockedAt"
    );

    if (["bounce", "complaint"].includes(eventType)) {
      console.log(`[ses:event] received ${eventType} for ${normalizedEmail}`);
    }

    if (currentSubscriber) {
      const updatedSubscriber = await updateSubscriberFromEmailEvent({
        subscriber: currentSubscriber,
        eventType,
        timestamp,
        recipientEmail: normalizedEmail,
      });

      if (updatedSubscriber && ["bounce", "complaint"].includes(eventType)) {
        console.log(
          `[ses:event] subscriber state synced for ${normalizedEmail} as ${updatedSubscriber.status}`,
        );
      }
    }

    if (["send", "delivery", "open", "click"].includes(eventType)) {
      await updateSubscriberActivity(normalizedEmail, eventType, timestamp, vendorId);
    }

    if (shouldCreateSuppression({ eventType, bounceType })) {
      await upsertSuppressionFromEvent(
        {
          recipientEmail: normalizedEmail,
          campaignId,
          subscriberId,
          eventType,
          timestamp,
          vendorId,
        }
      );
    }

    if (campaignId) {
      await logCampaignActivity(
        campaignId,
        `event:${eventType}`,
        `Recipient ${normalizedEmail} triggered ${eventType}`,
        { messageId }
      );
      await updateCampaignCounters(campaignId);
    }

    return event;
  } catch (error) {
    if (error.code === 11000) {
      return EmailEvent.findOne({
        vendorId,
        messageId,
        recipientEmail: normalizedEmail,
        eventType,
        timestamp,
      });
    }

    throw error;
  }
};

export { storeEmailEvent };
