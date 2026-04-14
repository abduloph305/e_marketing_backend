import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailCampaign from "../models/EmailCampaign.js";
import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { env } from "../config/env.js";
import {
  logCampaignActivity,
  updateCampaignCounters,
} from "./campaignService.js";
import { sendCampaign as sendCampaignThroughSes } from "./sesService.js";
import { storeEmailEvent } from "./emailEventService.js";
import { buildSubscriberMatch } from "../utils/subscriberFilters.js";

const campaignPopulate = [
  { path: "templateId" },
  { path: "segmentId", select: "name rules" },
];

const buildCampaignRecipients = async (campaign) => {
  let match = { status: "subscribed" };

  if (campaign.segmentId?.rules?.length) {
    match = {
      $and: [{ status: "subscribed" }, buildSubscriberMatch({ rules: campaign.segmentId.rules })],
    };
  }

  const suppressedEmails = await SuppressionEntry.find().select("email -_id").lean();
  const suppressedSet = new Set(suppressedEmails.map((item) => item.email));
  const candidateRecipients = await Subscriber.find(match).limit(500);

  return candidateRecipients.filter((subscriber) => !suppressedSet.has(subscriber.email)).slice(0, 200);
};

const buildTrackingUrls = (recipientId) => {
  const publicBaseUrl = env.publicAppUrl;

  return {
    trackingPixelUrl: `${publicBaseUrl}/api/events/track/open/${recipientId}.gif`,
    clickTrackingUrl: `${publicBaseUrl}/api/events/track/click/${recipientId}`,
  };
};

const dispatchCampaign = async (campaignId, { mode = "manual" } = {}) => {
  const campaign = await EmailCampaign.findById(campaignId).populate(campaignPopulate);

  if (!campaign || !campaign.templateId) {
    throw new Error("Campaign or template not found");
  }

  const recipients = await buildCampaignRecipients(campaign);

  await EmailCampaign.findByIdAndUpdate(campaign._id, {
    status: "sending",
    sentAt: null,
    totalRecipients: recipients.length,
    totals: {
      sent: 0,
      delivered: 0,
      opens: 0,
      uniqueOpens: 0,
      clicks: 0,
      uniqueClicks: 0,
      bounces: 0,
      complaints: 0,
      unsubscribes: 0,
      conversions: 0,
      revenue: 0,
    },
  });

  await CampaignRecipient.deleteMany({ campaignId: campaign._id });
  const recipientRecords = await CampaignRecipient.insertMany(
    recipients.map((subscriber) => ({
      campaignId: campaign._id,
      subscriberId: subscriber._id,
      email: subscriber.email,
      status: "queued",
    }))
  );

  await logCampaignActivity(campaign._id, "send_started", "Campaign send started", {
    recipientCount: recipients.length,
    mode,
  });

  const recipientMap = new Map(
    recipientRecords.map((record) => [String(record.email).toLowerCase(), record])
  );

  for (const subscriber of recipients) {
    const recipientRecord = recipientMap.get(String(subscriber.email).toLowerCase());
    const trackingId = recipientRecord?._id;

    const { messageId } = await sendCampaignThroughSes({
      campaign,
      recipient: subscriber,
      tracking: trackingId ? buildTrackingUrls(trackingId) : null,
    });

    await CampaignRecipient.findOneAndUpdate(
      { campaignId: campaign._id, email: subscriber.email },
      {
        messageId,
        status: "sent",
        sentAt: new Date(),
      }
    );

    await storeEmailEvent({
      campaignId: campaign._id,
      subscriberId: subscriber._id,
      recipientEmail: subscriber.email,
      messageId,
      eventType: "send",
      timestamp: new Date(),
      rawPayload: { mode },
    });
  }

  const updatedCampaign = await EmailCampaign.findByIdAndUpdate(
    campaign._id,
    {
      status: "sent",
      sentAt: new Date(),
    },
    { returnDocument: "after" }
  )
    .populate({ path: "templateId", select: "name subject previewText" })
    .populate({ path: "segmentId", select: "name" });

  await updateCampaignCounters(campaign._id);
  await logCampaignActivity(campaign._id, "send_completed", "Campaign send completed", {
    sentCount: recipients.length,
    mode,
  });

  return {
    campaign: updatedCampaign,
    sentCount: recipients.length,
  };
};

const processDueScheduledCampaigns = async () => {
  const now = new Date();
  const dueCampaigns = await EmailCampaign.find({
    status: "scheduled",
    scheduledAt: { $lte: now },
  })
    .sort({ scheduledAt: 1 })
    .limit(20);

  const results = [];

  for (const campaign of dueCampaigns) {
    try {
      const result = await dispatchCampaign(campaign._id, { mode: "scheduled" });
      results.push({ campaignId: String(campaign._id), status: "sent", sentCount: result.sentCount });
    } catch (error) {
      await EmailCampaign.findByIdAndUpdate(campaign._id, { status: "failed" });
      await logCampaignActivity(campaign._id, "send_failed", "Scheduled campaign send failed", {
        error: error.message,
      });
      results.push({
        campaignId: String(campaign._id),
        status: "failed",
        error: error.message,
      });
    }
  }

  return results;
};

export { dispatchCampaign, processDueScheduledCampaigns };
