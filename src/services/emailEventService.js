import EmailEvent from "../models/EmailEvent.js";
import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import {
  logCampaignActivity,
  updateCampaignCounters,
  updateCampaignRecipientStatus,
} from "./campaignService.js";

const subscriberStatusMap = {
  bounce: "bounced",
  complaint: "complained",
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

const shouldCreateSuppression = ({ eventType, bounceType }) =>
  eventType === "complaint" || (eventType === "bounce" && bounceType === "Permanent");

const resolveSuppressionReason = (eventType) => {
  if (eventType === "complaint") return "complaint";
  if (eventType === "bounce") return "bounce";
  if (eventType === "reject") return "reject";
  if (eventType === "unsubscribe") return "unsubscribe";
  return "manual";
};

const recalculateEngagementScore = (subscriber = {}) =>
  Math.round(
    Number(subscriber.totalOrders || 0) * 18 +
      Number(subscriber.totalSpent || 0) * 0.08 +
      (subscriber.lastOpenAt ? 8 : 0) +
      (subscriber.lastClickAt ? 16 : 0)
  );

const updateSubscriberActivity = async (recipientEmail, eventType, timestamp) => {
  const subscriber = await Subscriber.findOne({ email: recipientEmail }).lean();

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

    nextState.engagementScore = recalculateEngagementScore(merged);
  }

  await Subscriber.findByIdAndUpdate(subscriber._id, {
    $set: nextState,
  });
};

const storeEmailEvent = async ({
  campaignId = null,
  subscriberId = null,
  recipientEmail,
  messageId,
  eventType,
  timestamp,
  rawPayload = null,
  bounceType = "",
  bounceSubType = "",
  complaintFeedbackType = "",
  clickedLink = "",
  ipAddress = "",
  userAgent = "",
  deviceType = "",
  geo = null,
}) => {
  try {
    if (singularEventTypes.has(eventType)) {
      const existingEvent = await EmailEvent.findOne({
        messageId,
        recipientEmail,
        eventType,
      });

      if (existingEvent) {
        return existingEvent;
      }
    }

    const event = await EmailEvent.create({
      campaignId,
      subscriberId,
      recipientEmail,
      messageId,
      eventType,
      timestamp,
      rawPayload,
      bounceType,
      bounceSubType,
      complaintFeedbackType,
      clickedLink,
      ipAddress,
      userAgent,
      deviceType,
      geo,
    });

    await updateCampaignRecipientStatus({
      campaignId,
      subscriberId,
      recipientEmail,
      messageId,
      eventType,
      timestamp,
    });

    const subscriberStatus = subscriberStatusMap[eventType];
    if (subscriberStatus) {
      await Subscriber.findOneAndUpdate(
        { email: recipientEmail },
        { status: subscriberStatus },
        { returnDocument: "after" }
      );
    }

    if (["send", "delivery", "open", "click"].includes(eventType)) {
      await updateSubscriberActivity(recipientEmail, eventType, timestamp);
    }

    if (shouldCreateSuppression({ eventType, bounceType })) {
      await SuppressionEntry.findOneAndUpdate(
        { email: recipientEmail },
        {
          email: recipientEmail,
          reason: resolveSuppressionReason(eventType),
          source: "ses",
          status: "active",
          relatedCampaignId: campaignId,
          relatedSubscriberId: subscriberId,
        },
        {
          upsert: true,
          returnDocument: "after",
          setDefaultsOnInsert: true,
        }
      );
    }

    if (campaignId) {
      await logCampaignActivity(
        campaignId,
        `event:${eventType}`,
        `Recipient ${recipientEmail} triggered ${eventType}`,
        { messageId }
      );
      await updateCampaignCounters(campaignId);
    }

    return event;
  } catch (error) {
    if (error.code === 11000) {
      return EmailEvent.findOne({
        messageId,
        recipientEmail,
        eventType,
        timestamp,
      });
    }

    throw error;
  }
};

export { storeEmailEvent };
