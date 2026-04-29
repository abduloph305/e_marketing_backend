import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailCampaign from "../models/EmailCampaign.js";
import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { env } from "../config/env.js";
import {
  logCampaignActivity,
  updateCampaignCounters,
} from "./campaignService.js";
import { buildNextRecurringRun } from "../utils/campaignRecurrence.js";
import { sendCampaign as sendCampaignThroughSes } from "./sesService.js";
import { storeEmailEvent } from "./emailEventService.js";
import { buildSegmentQuery, normalizeSegmentDefinition } from "../utils/segmentEngine.js";
import { buildWebsiteScopeMatch, combineAudienceMatches } from "../utils/audienceWebsiteScope.js";
import { isSubscriberEligibleForEmail } from "../utils/emailEligibility.js";
import { assertEmailQuota, recordEmailUsage } from "./billingService.js";

const campaignPopulate = [
  { path: "templateId" },
  { path: "segmentId", select: "name definition rules websiteScope" },
];

const claimDueCampaign = async (campaignId) => {
  const claimedCampaign = await EmailCampaign.findOneAndUpdate(
    {
      _id: campaignId,
      status: "scheduled",
    },
    {
      $set: {
        status: "sending",
      },
    },
    {
      returnDocument: "after",
    },
  ).populate(campaignPopulate);

  return claimedCampaign;
};

const buildCampaignRecipients = async (campaign) => {
  const vendorMatch = campaign.vendorId ? { vendorId: campaign.vendorId } : {};
  const baseMatch = combineAudienceMatches(
    vendorMatch,
    { status: "subscribed" },
    buildWebsiteScopeMatch(campaign.websiteScope || {}),
    buildWebsiteScopeMatch(campaign.segmentId?.websiteScope || {}),
  );
  let match = baseMatch;

  const definition = normalizeSegmentDefinition(
    campaign.segmentId?.definition || { rules: campaign.segmentId?.rules || [] },
  );

  if (definition.filters.length) {
    match = combineAudienceMatches(baseMatch, buildSegmentQuery(definition));
  }

  const suppressedEmails = await SuppressionEntry.find(vendorMatch).select("email -_id").lean();
  const suppressedSet = new Set(
    suppressedEmails.map((item) => String(item.email || "").toLowerCase()),
  );
  const candidateRecipients = await Subscriber.find(match).limit(500);

  return candidateRecipients
    .filter(
      (subscriber) =>
        isSubscriberEligibleForEmail(subscriber) &&
        !suppressedSet.has(String(subscriber.email || "").toLowerCase()),
    )
    .slice(0, 200);
};

const estimateCampaignRecipientCount = async (campaignId) => {
  const campaign = await EmailCampaign.findById(campaignId).populate(campaignPopulate);

  if (!campaign) {
    return 0;
  }

  const recipients = await buildCampaignRecipients(campaign);
  return recipients.length;
};

const buildTrackingUrls = (recipientId) => {
  const publicBaseUrl = env.publicAppUrl;

  return {
    trackingPixelUrl: `${publicBaseUrl}/api/events/track/open/${recipientId}.gif`,
    clickTrackingUrl: `${publicBaseUrl}/api/events/track/click/${recipientId}`,
  };
};

const dispatchCampaign = async (campaignId, { mode = "manual", scopeMatch = {} } = {}) => {
  const campaign = await EmailCampaign.findOne({ _id: campaignId, ...scopeMatch }).populate(campaignPopulate);

  if (!campaign || !campaign.templateId) {
    throw new Error("Campaign or template not found");
  }

  const recipients = await buildCampaignRecipients(campaign);
  if (campaign.vendorId) {
    await assertEmailQuota(campaign.vendorId, recipients.length);
  }

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

  const vendorMatch = campaign.vendorId ? { vendorId: campaign.vendorId } : {};

  await CampaignRecipient.deleteMany({ campaignId: campaign._id, ...vendorMatch });
  const recipientRecords = await CampaignRecipient.insertMany(
    recipients.map((subscriber) => ({
      vendorId: campaign.vendorId || "",
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
      { campaignId: campaign._id, email: subscriber.email, ...vendorMatch },
      {
        messageId,
        status: "sent",
        sentAt: new Date(),
      }
    );

    await storeEmailEvent({
      campaignId: campaign._id,
      subscriberId: subscriber._id,
      vendorId: campaign.vendorId || "",
      recipientEmail: subscriber.email,
      messageId,
      eventType: "send",
      timestamp: new Date(),
      rawPayload: { mode },
    });
  }

  let updatedCampaign = await EmailCampaign.findByIdAndUpdate(
    campaign._id,
    {
      status: "sent",
      sentAt: new Date(),
    },
    { returnDocument: "after" }
  )
    .populate({ path: "templateId", select: "name subject previewText" })
    .populate({ path: "segmentId", select: "name websiteScope" });

  await updateCampaignCounters(campaign._id);
  await recordEmailUsage({
    vendorId: campaign.vendorId || "",
    count: recipients.length,
    sourceId: campaign._id,
    sourceType: "campaign",
    metadata: { mode },
  });
  await logCampaignActivity(campaign._id, "send_completed", "Campaign send completed", {
    sentCount: recipients.length,
    mode,
  });

  if (campaign.isRecurring) {
    const nextRunAt = buildNextRecurringRun(campaign);
    const nextRunCount = Number(campaign.recurrenceRunCount || 0) + 1;

    await EmailCampaign.findByIdAndUpdate(campaign._id, {
      recurrenceRunCount: nextRunCount,
      recurrenceLastRunAt: new Date(),
    });

    if (nextRunAt) {
      await EmailCampaign.findByIdAndUpdate(campaign._id, {
        status: "scheduled",
        scheduledAt: nextRunAt,
      });

      await logCampaignActivity(campaign._id, "rescheduled", "Recurring campaign rescheduled", {
        nextRunAt,
      });

      updatedCampaign = await EmailCampaign.findById(campaign._id)
        .populate({ path: "templateId", select: "name subject previewText" })
        .populate({ path: "segmentId", select: "name websiteScope" });
    }
  }

  return {
    campaign: updatedCampaign,
    sentCount: recipients.length,
  };
};

const processDueScheduledCampaigns = async () => {
  const results = [];

  while (true) {
    const now = new Date();
    const nextDueCampaign = await EmailCampaign.findOne({
      status: "scheduled",
      scheduledAt: { $lte: now },
    })
      .sort({ scheduledAt: 1, createdAt: 1 })
      .select("_id name scheduledAt")
      .lean();

    if (!nextDueCampaign) {
      break;
    }

    console.log(
      `[scheduler:campaigns] picked campaign ${nextDueCampaign._id} (${nextDueCampaign.name || "unnamed"}) due at ${new Date(nextDueCampaign.scheduledAt).toISOString()}`,
    );

    const claimedCampaign = await claimDueCampaign(nextDueCampaign._id);

    if (!claimedCampaign) {
      console.log(
        `[scheduler:campaigns] campaign ${nextDueCampaign._id} was already claimed by another worker`,
      );
      continue;
    }

    try {
      const result = await dispatchCampaign(claimedCampaign._id, { mode: "scheduled" });
      console.log(
        `[scheduler:campaigns] sent campaign ${claimedCampaign._id} (${result.sentCount} recipient(s))`,
      );
      results.push({
        campaignId: String(claimedCampaign._id),
        status: "sent",
        sentCount: result.sentCount,
      });
    } catch (error) {
      await EmailCampaign.findByIdAndUpdate(claimedCampaign._id, { status: "failed" });
      console.error(
        `[scheduler:campaigns] failed campaign ${claimedCampaign._id}`,
        error,
      );
      await logCampaignActivity(claimedCampaign._id, "send_failed", "Scheduled campaign send failed", {
        error: error.message,
      });
      results.push({
        campaignId: String(claimedCampaign._id),
        status: "failed",
        error: error.message,
      });
    }
  }

  return results;
};

export { dispatchCampaign, estimateCampaignRecipientCount, processDueScheduledCampaigns };
