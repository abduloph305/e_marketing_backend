import EmailCampaign from "../models/EmailCampaign.js";
import { dispatchCampaign } from "../services/campaignDispatchService.js";
import { logCampaignActivity } from "../services/campaignService.js";
import { sendTestEmail as sendTestEmailThroughSes } from "../services/sesService.js";
import { sendTransactionalEmail } from "../services/sesService.js";
import { storeEmailEvent } from "../services/emailEventService.js";

const campaignPopulate = [
  { path: "templateId" },
  { path: "segmentId", select: "name rules" },
];

const parseEmailList = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [value])
        .flatMap((entry) => String(entry || "").split(/[\n,]+/))
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

const sendTestEmail = async (req, res) => {
  try {
    const campaign = await EmailCampaign.findById(req.params.id).populate(campaignPopulate);

    if (!campaign || !campaign.templateId) {
      return res.status(404).json({ message: "Campaign or template not found" });
    }

    const testRecipients = parseEmailList(req.body.emails || req.body.email);

    if (!testRecipients.length) {
      return res.status(400).json({ message: "Test recipient email is required" });
    }

    const results = [];

    for (const recipientEmail of testRecipients) {
      const { messageId } = await sendTestEmailThroughSes({
        campaign,
        recipientEmail,
      });

      await logCampaignActivity(campaign._id, "test_sent", "Test email sent", {
        recipientEmail,
        messageId,
      });

      await storeEmailEvent({
        campaignId: campaign._id,
        recipientEmail,
        messageId,
        eventType: "send",
        timestamp: new Date(),
        rawPayload: { mode: "test" },
      });

      results.push({ recipientEmail, messageId });
    }

    return res.json({
      message: "Test email sent",
      count: results.length,
      results,
    });
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

const stripHtml = (html = "") =>
  String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const sendAdHocTestEmail = async (req, res) => {
  try {
    const recipientEmails = parseEmailList(req.body.emails || req.body.email);
    const subject = String(req.body.subject || "").trim();
    const html = String(req.body.html || "").trim();
    const message = String(req.body.message || "").trim();

    if (!recipientEmails.length) {
      return res.status(400).json({ message: "Recipient email is required" });
    }

    if (!subject) {
      return res.status(400).json({ message: "Subject is required" });
    }

    if (!html) {
      return res.status(400).json({ message: "Email content is required" });
    }

    const text = message ? `${message}\n\n${stripHtml(html)}` : stripHtml(html);

    const results = [];

    for (const recipientEmail of recipientEmails) {
      const { messageId } = await sendTransactionalEmail({
        to: recipientEmail,
        subject,
        html,
        text: text || subject,
      });

      results.push({ recipientEmail, messageId });
    }

    return res.json({
      message: "Test email sent",
      count: results.length,
      results,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unable to send test email" });
  }
};

export { sendAdHocTestEmail, sendCampaign, sendTestEmail };
