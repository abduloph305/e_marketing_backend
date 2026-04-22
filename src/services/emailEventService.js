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

const shouldCreateSuppression = ({ eventType, bounceType }) =>
  eventType === "complaint" || (eventType === "bounce" && bounceType === "Permanent");

const resolveSuppressionReason = (eventType) => {
  if (eventType === "complaint") return "complaint";
  if (eventType === "bounce") return "bounce";
  if (eventType === "reject") return "reject";
  if (eventType === "unsubscribe") return "unsubscribe";
  return "manual";
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

    nextState.engagementScore = recalculateEngagementScore(merged, timestamp);
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
  blockId = "",
  section = "",
  ctaType = "",
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
      recipientEmail,
      messageId,
      eventType,
      timestamp,
    });

    const currentSubscriber = await Subscriber.findOne({ email: recipientEmail }).select(
      "status blockedReason blockedAt"
    );

    const subscriberStatus = subscriberStatusMap[eventType];
    if (subscriberStatus && currentSubscriber) {
      if (currentSubscriber.status === "blocked" && subscriberStatus !== "blocked") {
        // Keep spam or manually blocked contacts locked out of sends.
      } else {
        const nextSubscriberUpdate = { status: subscriberStatus };

        if (subscriberStatus === "blocked") {
          nextSubscriberUpdate.blockedReason = "spam";
          nextSubscriberUpdate.blockedAt = timestamp;
        } else {
          nextSubscriberUpdate.blockedReason = "";
          nextSubscriberUpdate.blockedAt = null;
        }

        await Subscriber.findByIdAndUpdate(currentSubscriber._id, nextSubscriberUpdate, {
          returnDocument: "after",
        });
      }
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
