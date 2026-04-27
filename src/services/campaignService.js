import CampaignActivityLog from "../models/CampaignActivityLog.js";
import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailCampaign from "../models/EmailCampaign.js";
import EmailEvent from "../models/EmailEvent.js";
import mongoose from "mongoose";

const logCampaignActivity = async (campaignId, type, message, metadata = null) =>
  CampaignActivityLog.create({
    campaignId,
    type,
    message,
    metadata,
  });

const recipientEventConfig = {
  send: { status: "sent", dateField: "sentAt" },
  delivery: { status: "delivered", dateField: "deliveredAt" },
  open: { status: "opened", dateField: "openedAt" },
  click: { status: "clicked", dateField: "clickedAt" },
  bounce: { status: "bounced", dateField: "bouncedAt" },
  complaint: { status: "complained", dateField: "complainedAt" },
  unsubscribe: { status: "unsubscribed", dateField: "unsubscribedAt" },
  delivery_delay: { status: "delivery_delayed", dateField: null },
  rendering_failure: { status: "rendering_failed", dateField: null },
  reject: { status: "rejected", dateField: null },
};

const normalizeObjectId = (value = null) => {
  const id = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(id) ? id : null;
};

const updateCampaignRecipientStatus = async ({
  campaignId = null,
  subscriberId = null,
  recipientEmail,
  messageId,
  eventType,
  timestamp,
}) => {
  const eventConfig = recipientEventConfig[eventType];

  if (!eventConfig) {
    return null;
  }

  const match = messageId
    ? { messageId }
    : campaignId && recipientEmail
      ? { campaignId, email: recipientEmail }
      : null;

  if (!match) {
    return null;
  }

  const updates = {
    status: eventConfig.status,
  };

  if (eventConfig.dateField) {
    updates[eventConfig.dateField] = timestamp;
  }

  if (campaignId) {
    updates.campaignId = campaignId;
  }

  if (subscriberId) {
    updates.subscriberId = subscriberId;
  }

  if (recipientEmail) {
    updates.email = recipientEmail;
  }

  if (messageId) {
    updates.messageId = messageId;
  }

  return CampaignRecipient.findOneAndUpdate(
    match,
    {
      $set: updates,
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );
};

const updateCampaignCounters = async (campaignId) => {
  const campaignObjectId = new mongoose.Types.ObjectId(String(campaignId));
  const [
    eventSummary,
    totalRecipients,
    uniqueOpens,
    uniqueClicks,
    unsubscribes,
    conversionCounts,
    convertedRecipients,
    revenue,
  ] =
    await Promise.all([
      EmailEvent.aggregate([
        { $match: { campaignId: campaignObjectId } },
        {
          $group: {
            _id: "$eventType",
            count: { $sum: 1 },
          },
        },
      ]),
      CampaignRecipient.countDocuments({ campaignId }),
      CampaignRecipient.countDocuments({ campaignId, openedAt: { $ne: null } }),
      CampaignRecipient.countDocuments({ campaignId, clickedAt: { $ne: null } }),
      CampaignRecipient.countDocuments({ campaignId, unsubscribedAt: { $ne: null } }),
      CampaignRecipient.aggregate([
        { $match: { campaignId: campaignObjectId } },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ["$conversionCount", 0] } },
          },
        },
      ]),
      CampaignRecipient.countDocuments({ campaignId, convertedAt: { $ne: null } }),
      CampaignRecipient.aggregate([
        { $match: { campaignId: campaignObjectId } },
        {
          $group: {
            _id: null,
            total: { $sum: "$revenueAttributed" },
          },
        },
      ]),
    ]);

  const totals = {
    sent: 0,
    delivered: 0,
    opens: 0,
    uniqueOpens: uniqueOpens || 0,
    clicks: 0,
    uniqueClicks: uniqueClicks || 0,
    bounces: 0,
    complaints: 0,
    unsubscribes: unsubscribes || 0,
    conversions: conversionCounts[0]?.total || convertedRecipients || 0,
    revenue: revenue[0]?.total || 0,
  };

  eventSummary.forEach((row) => {
    if (row._id === "send") totals.sent = row.count;
    if (row._id === "delivery") totals.delivered = row.count;
    if (row._id === "open") totals.opens = row.count;
    if (row._id === "click") totals.clicks = row.count;
    if (row._id === "bounce") totals.bounces = row.count;
    if (row._id === "complaint") totals.complaints = row.count;
    if (row._id === "unsubscribe") totals.unsubscribes = Math.max(totals.unsubscribes, row.count);
  });

  return EmailCampaign.findByIdAndUpdate(
    campaignId,
    {
      totalRecipients,
      totals,
    },
    { returnDocument: "after" }
  );
};

const findAttributionRecipient = async ({
  campaignId = null,
  email = "",
  messageId = null,
  recipientId = null,
}) => {
  const normalizedCampaignId = normalizeObjectId(campaignId);
  const normalizedRecipientId = normalizeObjectId(recipientId);
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (normalizedRecipientId) {
    const recipientById = await CampaignRecipient.findById(normalizedRecipientId).lean();
    if (recipientById) {
      return recipientById;
    }
  }

  if (messageId) {
    const recipientByMessageId = await CampaignRecipient.findOne({ messageId }).lean();
    if (recipientByMessageId) {
      return recipientByMessageId;
    }
  }

  if (normalizedCampaignId && normalizedEmail) {
    const recipientByCampaign = await CampaignRecipient.findOne({
      campaignId: normalizedCampaignId,
      email: normalizedEmail,
    }).lean();

    if (recipientByCampaign) {
      return recipientByCampaign;
    }
  }

  if (!normalizedEmail) {
    return null;
  }

  return CampaignRecipient.findOne({ email: normalizedEmail })
    .sort({
      clickedAt: -1,
      openedAt: -1,
      sentAt: -1,
      convertedAt: -1,
      updatedAt: -1,
    })
    .lean();
};

const attributeCampaignConversion = async ({
  campaignId = null,
  email = "",
  messageId = null,
  recipientId = null,
  convertedAt = new Date(),
  revenueAttributed = 0,
  sourceEventId = "",
  sourceEventType = "",
}) => {
  const normalizedCampaignId = normalizeObjectId(campaignId);
  const recipient = await findAttributionRecipient({ campaignId, email, messageId, recipientId });

  if (!recipient) {
    return null;
  }

  const resolvedEmail = String(email || recipient.email || "").trim().toLowerCase() || recipient.email;
  const nextRevenue = Math.max(0, Number(revenueAttributed || 0));
  const normalizedSourceId = String(sourceEventId || "").trim();
  const normalizedSourceType = String(sourceEventType || "").trim();

  if (
    normalizedSourceId &&
    (
      String(recipient.lastConversionSourceId || "") === normalizedSourceId ||
      (Array.isArray(recipient.conversionSourceIds) &&
        recipient.conversionSourceIds.includes(normalizedSourceId))
    )
  ) {
    return recipient;
  }

  const update = {
    $set: {
      status: "converted",
      convertedAt: recipient.convertedAt || convertedAt,
      lastConvertedAt: convertedAt,
      lastConversionSourceId: normalizedSourceId || recipient.lastConversionSourceId || "",
      lastConversionSourceType: normalizedSourceType || recipient.lastConversionSourceType || "",
      campaignId: normalizedCampaignId || recipient.campaignId || null,
      email: resolvedEmail,
    },
    $inc: {
      conversionCount: 1,
      revenueAttributed: nextRevenue,
    },
  };

  if (normalizedSourceId) {
    update.$addToSet = {
      conversionSourceIds: normalizedSourceId,
    };
  }

  const updatedRecipient = await CampaignRecipient.findByIdAndUpdate(
    recipient._id,
    update,
    { returnDocument: "after", runValidators: true }
  );

  if (updatedRecipient?.campaignId) {
    await updateCampaignCounters(updatedRecipient.campaignId);
  }

  return updatedRecipient;
};

const buildCampaignDetailPayload = async (campaignId) => {
  const campaign = await EmailCampaign.findById(campaignId)
    .populate({ path: "templateId", select: "name subject previewText" })
    .populate({ path: "segmentId", select: "name" });

  if (!campaign) {
    return null;
  }

  const campaignObjectId = new mongoose.Types.ObjectId(String(campaign._id));

  const [activityTimeline, recipientProgress, recentEvents, topLinks, clickMapRows, trendRows] = await Promise.all([
    CampaignActivityLog.find({ campaignId }).sort({ createdAt: -1 }).limit(20).lean(),
    CampaignRecipient.find({ campaignId })
      .sort({ updatedAt: -1 })
      .limit(20)
      .select(
        "email status sentAt deliveredAt openedAt clickedAt bouncedAt complainedAt unsubscribedAt convertedAt lastConvertedAt lastConversionSourceId lastConversionSourceType conversionCount revenueAttributed"
      )
      .lean(),
    EmailEvent.find({ campaignId })
      .sort({ timestamp: -1 })
      .limit(12)
      .select("recipientEmail eventType timestamp clickedLink blockId section ctaType bounceType complaintFeedbackType deviceType ipAddress")
      .lean(),
    EmailEvent.aggregate([
      { $match: { campaignId: campaignObjectId, eventType: "click", clickedLink: { $ne: "" } } },
      {
        $group: {
          _id: "$clickedLink",
          totalClicks: { $sum: 1 },
        },
      },
      { $sort: { totalClicks: -1 } },
      { $limit: 5 },
    ]),
    EmailEvent.aggregate([
      {
        $match: {
          campaignId: campaignObjectId,
          eventType: "click",
        },
      },
      {
        $group: {
          _id: {
            section: {
              $cond: [
                { $and: [{ $ne: ["$section", ""] }, { $ne: ["$section", null] }] },
                "$section",
                {
                  $switch: {
                    branches: [
                      { case: { $eq: ["$ctaType", "button"] }, then: "CTA button" },
                      { case: { $eq: ["$ctaType", "image"] }, then: "Image block" },
                      { case: { $eq: ["$ctaType", "video"] }, then: "Video block" },
                      { case: { $eq: ["$ctaType", "logo"] }, then: "Brand logo" },
                      { case: { $eq: ["$ctaType", "navigation"] }, then: "Navigation links" },
                      { case: { $eq: ["$ctaType", "social"] }, then: "Social links" },
                    ],
                    default: "Other links",
                  },
                },
              ],
            },
            blockId: "$blockId",
          },
          totalClicks: { $sum: 1 },
          recipients: { $addToSet: "$recipientEmail" },
        },
      },
      { $sort: { totalClicks: -1 } },
    ]),
    EmailEvent.aggregate([
      { $match: { campaignId: campaignObjectId, eventType: { $in: ["send", "delivery", "open", "click"] } } },
      {
        $group: {
          _id: {
            day: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$timestamp",
              },
            },
            eventType: "$eventType",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]),
  ]);

  const trendMap = new Map();
  trendRows.forEach((row) => {
    const key = row._id.day;
    if (!trendMap.has(key)) {
      trendMap.set(key, { date: key, sent: 0, delivered: 0, opens: 0, clicks: 0 });
    }

    if (row._id.eventType === "send") trendMap.get(key).sent = row.count;
    if (row._id.eventType === "delivery") trendMap.get(key).delivered = row.count;
    if (row._id.eventType === "open") trendMap.get(key).opens = row.count;
    if (row._id.eventType === "click") trendMap.get(key).clicks = row.count;
  });

  const totals = campaign.totals || {};
  const sendProgressPercent = campaign.totalRecipients
    ? Math.round(((totals.sent || 0) / campaign.totalRecipients) * 100)
    : 0;

  return {
    ...campaign.toObject(),
    sendProgress: {
      percentage: Math.min(sendProgressPercent, 100),
      sent: totals.sent || 0,
      totalRecipients: campaign.totalRecipients || 0,
      remaining: Math.max((campaign.totalRecipients || 0) - (totals.sent || 0), 0),
    },
    activityTimeline,
    recipientProgress,
    recentEvents,
    topLinks: topLinks.map((item) => ({ url: item._id, totalClicks: item.totalClicks })),
    trendData: [...trendMap.values()],
    clickMap: clickMapRows
      .map((item) => ({
        section: item._id.section || "Other links",
        blockId: item._id.blockId || "",
        totalClicks: item.totalClicks || 0,
        uniqueRecipients: item.recipients?.length || 0,
      }))
      .sort((left, right) => right.totalClicks - left.totalClicks)
      .slice(0, 8),
  };
};

export {
  buildCampaignDetailPayload,
  attributeCampaignConversion,
  logCampaignActivity,
  updateCampaignCounters,
  updateCampaignRecipientStatus,
};
