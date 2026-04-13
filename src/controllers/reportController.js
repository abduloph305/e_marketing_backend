import EmailCampaign from "../models/EmailCampaign.js";
import EmailEvent from "../models/EmailEvent.js";
import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { buildDateRangeMatch } from "../utils/dateRange.js";

const summarizeEvents = async (match = {}) => {
  const rows = await EmailEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$eventType",
        count: { $sum: 1 },
      },
    },
  ]);

  const summary = {
    sent: 0,
    delivered: 0,
    opens: 0,
    clicks: 0,
    bounces: 0,
    complaints: 0,
    unsubscribes: 0,
  };

  rows.forEach((row) => {
    if (row._id === "send") summary.sent = row.count;
    if (row._id === "delivery") summary.delivered = row.count;
    if (row._id === "open") summary.opens = row.count;
    if (row._id === "click") summary.clicks = row.count;
    if (row._id === "bounce") summary.bounces = row.count;
    if (row._id === "complaint") summary.complaints = row.count;
    if (row._id === "unsubscribe") summary.unsubscribes = row.count;
  });

  return summary;
};

const getRangeSummary = async (days) => {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - (days - 1));

  const [events, campaigns, subscribers, suppressions] = await Promise.all([
    summarizeEvents({
      timestamp: {
        $gte: startDate,
        $lte: endDate,
      },
    }),
    EmailCampaign.countDocuments(
      buildDateRangeMatch(startDate.toISOString(), endDate.toISOString())
    ),
    Subscriber.countDocuments(
      buildDateRangeMatch(startDate.toISOString(), endDate.toISOString())
    ),
    SuppressionEntry.countDocuments({
      status: "active",
      ...buildDateRangeMatch(startDate.toISOString(), endDate.toISOString()),
    }),
  ]);

  return {
    campaigns,
    newSubscribers: subscribers,
    suppressions,
    ...events,
  };
};

const getCampaignReportRows = async () => {
  const campaigns = await EmailCampaign.find()
    .select("name status type goal totals totalRecipients sentAt scheduledAt")
    .sort({ updatedAt: -1 })
    .limit(8)
    .lean();

  return campaigns.map((campaign) => ({
    _id: campaign._id,
    name: campaign.name,
    status: campaign.status,
    type: campaign.type,
    goal: campaign.goal,
    recipients: campaign.totalRecipients || 0,
    sent: campaign.totals?.sent || 0,
    delivered: campaign.totals?.delivered || 0,
    opens: campaign.totals?.opens || 0,
    clicks: campaign.totals?.clicks || 0,
    scheduledAt: campaign.scheduledAt,
    sentAt: campaign.sentAt,
  }));
};

const getAudienceGrowthReport = async () => {
  const growth = await Subscriber.aggregate([
    {
      $group: {
        _id: {
          month: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
        },
        subscribers: { $sum: 1 },
      },
    },
    { $sort: { "_id.month": 1 } },
  ]);

  return growth.slice(-6).map((item) => ({
    period: item._id.month,
    subscribers: item.subscribers,
  }));
};

const getDeliverabilityReport = async () => {
  const summary = await summarizeEvents({});
  const sent = summary.sent || 0;

  return {
    ...summary,
    bounceRate: sent ? Number(((summary.bounces / sent) * 100).toFixed(2)) : 0,
    complaintRate: sent ? Number(((summary.complaints / sent) * 100).toFixed(2)) : 0,
    unsubscribeRate: sent ? Number(((summary.unsubscribes / sent) * 100).toFixed(2)) : 0,
  };
};

const getReportsOverview = async (_req, res) => {
  const [dailySummary, weeklySummary, monthlySummary, campaignReport, audienceGrowth, deliverability] =
    await Promise.all([
      getRangeSummary(1),
      getRangeSummary(7),
      getRangeSummary(30),
      getCampaignReportRows(),
      getAudienceGrowthReport(),
      getDeliverabilityReport(),
    ]);

  return res.json({
    dailySummary,
    weeklySummary,
    monthlySummary,
    campaignReport,
    audienceGrowth,
    deliverability,
    exportFormats: ["csv", "excel", "pdf_placeholder"],
  });
};

const exportReports = async (req, res) => {
  const format = req.query.format || "csv";
  const report = req.query.report || "daily_summary";

  return res.json({
    message: `Export scaffold ready for ${report} in ${format} format`,
    report,
    format,
    state: "scaffolded",
  });
};

export { getReportsOverview, exportReports };
