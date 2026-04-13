import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailCampaign from "../models/EmailCampaign.js";
import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import {
  logCampaignActivity,
  updateCampaignCounters,
} from "../services/campaignService.js";
import { env } from "../config/env.js";
import {
  sendCampaign as sendCampaignThroughSes,
  sendTestEmail as sendTestEmailThroughSes,
} from "../services/sesService.js";
import { storeEmailEvent } from "../services/emailEventService.js";
import { buildSubscriberMatch } from "../utils/subscriberFilters.js";

const campaignPopulate = [
  { path: "templateId" },
  { path: "segmentId", select: "name rules" },
];

const sendTestEmail = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findById(req.params.id).populate(campaignPopulate);

    if (!campaign || !campaign.templateId) {
      return res.status(404).json({ message: "Campaign or template not found" });
    }

    const testRecipient = req.body.email?.trim().toLowerCase();

    if (!testRecipient) {
      return res.status(400).json({ message: "Test recipient email is required" });
    }

    const { messageId } = await sendTestEmailThroughSes({
      campaign,
      recipientEmail: testRecipient,
    });

    await logCampaignActivity(campaign._id, "test_sent", "Test email sent", {
      recipientEmail: testRecipient,
      messageId,
    });

    await storeEmailEvent({
      campaignId: campaign._id,
      recipientEmail: testRecipient,
      messageId,
      eventType: "send",
      timestamp: new Date(),
      rawPayload: { mode: "test" },
    });

    return res.json({ message: "Test email sent", messageId });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unable to send test email" });
  }
};

const sendCampaign = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findById(req.params.id).populate(campaignPopulate);

    if (!campaign || !campaign.templateId) {
      return res.status(404).json({ message: "Campaign or template not found" });
    }

    let match = { status: "subscribed" };

    if (campaign.segmentId?.rules?.length) {
      match = {
        $and: [{ status: "subscribed" }, buildSubscriberMatch({ rules: campaign.segmentId.rules })],
      };
    }

    const suppressedEmails = await SuppressionEntry.find().select("email -_id").lean();
    const suppressedSet = new Set(suppressedEmails.map((item) => item.email));
    const candidateRecipients = await Subscriber.find(match).limit(500);
    const recipients = candidateRecipients
      .filter((subscriber) => !suppressedSet.has(subscriber.email))
      .slice(0, 200);
    const publicBaseUrl = env.publicAppUrl;

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
        tracking: trackingId
          ? {
              trackingPixelUrl: `${publicBaseUrl}/api/events/track/open/${trackingId}.gif`,
              clickTrackingUrl: `${publicBaseUrl}/api/events/track/click/${trackingId}`,
            }
          : null,
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
    });

    return res.json({
      message: "Campaign send completed",
      sentCount: recipients.length,
      campaign: updatedCampaign,
    });
  } catch (error) {
    await EmailCampaign.findByIdAndUpdate(req.params.id, { status: "failed" });

    if (req.params.id) {
      await logCampaignActivity(req.params.id, "send_failed", "Campaign send failed", {
        error: error.message,
      });
    }

    return res.status(400).json({ message: error.message || "Unable to send campaign" });
  }
};

export { sendCampaign, sendTestEmail };
