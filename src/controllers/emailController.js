import EmailCampaign from "../models/EmailCampaign.js";
import { dispatchCampaign } from "../services/campaignDispatchService.js";
import { logCampaignActivity } from "../services/campaignService.js";
import { sendTestEmail as sendTestEmailThroughSes } from "../services/sesService.js";
import { storeEmailEvent } from "../services/emailEventService.js";

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
    const result = await dispatchCampaign(req.params.id, { mode: "manual" });
    return res.json({
      message: "Campaign send completed",
      sentCount: result.sentCount,
      campaign: result.campaign,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unable to send campaign" });
  }
};

export { sendCampaign, sendTestEmail };
