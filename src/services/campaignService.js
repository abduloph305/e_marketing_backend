import CampaignActivityLog from "../models/CampaignActivityLog.js";
import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailCampaign from "../models/EmailCampaign.js";
import EmailEvent from "../models/EmailEvent.js";

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
  const [eventSummary, totalRecipients, uniqueOpens, uniqueClicks, unsubscribes, conversions, revenue] =
    await Promise.all([
      EmailEvent.aggregate([
        { $match: { campaignId } },
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
      CampaignRecipient.countDocuments({ campaignId, convertedAt: { $ne: null } }),
      CampaignRecipient.aggregate([
        { $match: { campaignId } },
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
    conversions: conversions || 0,
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

const buildCampaignDetailPayload = async (campaignId) => {
  const campaign = await EmailCampaign.findById(campaignId)
    .populate({ path: "templateId", select: "name subject previewText" })
    .populate({ path: "segmentId", select: "name" });

  if (!campaign) {
    return null;
  }

  const [activityTimeline, recipientProgress, recentEvents, topLinks, trendRows] = await Promise.all([
    CampaignActivityLog.find({ campaignId }).sort({ createdAt: -1 }).limit(20).lean(),
    CampaignRecipient.find({ campaignId })
      .sort({ updatedAt: -1 })
      .limit(20)
      .select("email status sentAt deliveredAt openedAt clickedAt bouncedAt complainedAt unsubscribedAt convertedAt revenueAttributed")
      .lean(),
    EmailEvent.find({ campaignId })
      .sort({ timestamp: -1 })
      .limit(12)
      .select("recipientEmail eventType timestamp clickedLink bounceType complaintFeedbackType deviceType ipAddress")
      .lean(),
    EmailEvent.aggregate([
      { $match: { campaignId, eventType: "click", clickedLink: { $ne: "" } } },
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
      { $match: { campaignId, eventType: { $in: ["send", "delivery", "open", "click"] } } },
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
  };
};

export {
  buildCampaignDetailPayload,
  logCampaignActivity,
  updateCampaignCounters,
  updateCampaignRecipientStatus,
};
