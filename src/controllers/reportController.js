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

const resolveReportWindow = (query = {}) => {
  const range = String(query.range || "30d").toLowerCase();
  const now = new Date();
  const endDate = new Date(now);
  const startDate = new Date(now);

  const parseDate = (value) => {
    if (!value) {
      return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  if (range === "today") {
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
    return {
      range,
      label: "Today",
      startDate,
      endDate,
    };
  }

  if (range === "7d") {
    startDate.setDate(endDate.getDate() - 6);
    return {
      range,
      label: "Last 7 days",
      startDate,
      endDate,
    };
  }

  if (range === "custom") {
    const customStart = parseDate(query.startDate);
    const customEnd = parseDate(query.endDate);

    return {
      range,
      label: "Custom range",
      startDate: customStart,
      endDate: customEnd,
    };
  }

  startDate.setDate(endDate.getDate() - 29);

  return {
    range: "30d",
    label: "Last 30 days",
    startDate,
    endDate,
  };
};

const buildWindowMatch = (window = {}, field = "createdAt") => {
  if (!window.startDate && !window.endDate) {
    return {};
  }

  return buildDateRangeMatch(
    window.startDate?.toISOString(),
    window.endDate?.toISOString(),
    field,
  );
};

const getRangeSummary = async (window) => {
  const [events, campaigns, subscribers, suppressions] = await Promise.all([
    summarizeEvents(buildWindowMatch(window, "timestamp")),
    EmailCampaign.countDocuments(buildWindowMatch(window)),
    Subscriber.countDocuments(buildWindowMatch(window)),
    SuppressionEntry.countDocuments({
      status: "active",
      ...buildWindowMatch(window),
    }),
  ]);

  return {
    campaigns,
    newSubscribers: subscribers,
    suppressions,
    ...events,
  };
};

const getCampaignReportRows = async (window = {}) => {
  const campaigns = await EmailCampaign.find()
    .select("name status type goal totals totalRecipients sentAt scheduledAt")
    .sort({ updatedAt: -1 })
    .limit(8)
    .lean();

  return campaigns
    .filter((campaign) => {
      if (!window.startDate && !window.endDate) {
        return true;
      }

      const anchor =
        campaign.sentAt || campaign.updatedAt || campaign.createdAt;

      if (!anchor) {
        return false;
      }

      const anchorDate = new Date(anchor);
      if (Number.isNaN(anchorDate.getTime())) {
        return false;
      }

      if (window.startDate && anchorDate < window.startDate) {
        return false;
      }

      if (window.endDate && anchorDate > window.endDate) {
        return false;
      }

      return true;
    })
    .map((campaign) => ({
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

const getAudienceGrowthReport = async (window = {}) => {
  const growth = await Subscriber.aggregate([
    { $match: buildWindowMatch(window) },
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

const getDeliverabilityReport = async (window = {}) => {
  const summary = await summarizeEvents(buildWindowMatch(window, "timestamp"));
  const sent = summary.sent || 0;

  return {
    ...summary,
    bounceRate: sent ? Number(((summary.bounces / sent) * 100).toFixed(2)) : 0,
    complaintRate: sent
      ? Number(((summary.complaints / sent) * 100).toFixed(2))
      : 0,
    unsubscribeRate: sent
      ? Number(((summary.unsubscribes / sent) * 100).toFixed(2))
      : 0,
  };
};

const getReportsOverview = async (req, res) => {
  const selectedWindow = resolveReportWindow(req.query);
  const [
    dailySummary,
    weeklySummary,
    monthlySummary,
    selectedSummary,
    campaignReport,
    audienceGrowth,
    deliverability,
  ] = await Promise.all([
    getRangeSummary(resolveReportWindow({ range: "today" })),
    getRangeSummary(resolveReportWindow({ range: "7d" })),
    getRangeSummary(resolveReportWindow({ range: "30d" })),
    getRangeSummary(selectedWindow),
    getCampaignReportRows(selectedWindow),
    getAudienceGrowthReport(selectedWindow),
    getDeliverabilityReport(selectedWindow),
  ]);

  return res.json({
    selectedRange: {
      range: selectedWindow.range,
      label: selectedWindow.label,
      startDate: selectedWindow.startDate,
      endDate: selectedWindow.endDate,
    },
    selectedSummary,
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
  const selectedWindow = resolveReportWindow(req.query);

  return res.json({
    message: `Export scaffold ready for ${report} in ${format} format for ${selectedWindow.label.toLowerCase()}`,
    report,
    format,
    range: selectedWindow.range,
    state: "scaffolded",
  });
};

export { getReportsOverview, exportReports };
