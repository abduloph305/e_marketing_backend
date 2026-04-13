import EmailCampaign from "../models/EmailCampaign.js";
import EmailEvent from "../models/EmailEvent.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { buildDateRangeMatch } from "../utils/dateRange.js";

const eventCountConfig = {
  send: "sent",
  delivery: "delivered",
  open: "opens",
  click: "clicks",
  bounce: "bounces",
  complaint: "complaints",
  reject: "rejectCount",
  delivery_delay: "deliveryDelayCount",
  rendering_failure: "renderingFailureCount",
  unsubscribe: "unsubscribeCount",
};

const escapeRegExp = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeSummary = (summary = {}) => {
  const sent = summary.sent || 0;
  const delivered = summary.delivered || 0;

  return {
    sent,
    delivered,
    opens: summary.opens || 0,
    clicks: summary.clicks || 0,
    bounces: summary.bounces || 0,
    complaints: summary.complaints || 0,
    unsubscribeCount: summary.unsubscribeCount || 0,
    hardBounceCount: summary.hardBounceCount || 0,
    softBounceCount: summary.softBounceCount || 0,
    rejectCount: summary.rejectCount || 0,
    deliveryDelayCount: summary.deliveryDelayCount || 0,
    renderingFailureCount: summary.renderingFailureCount || 0,
    suppressedCount: summary.suppressedCount || 0,
    openRate: sent ? Number((((summary.opens || 0) / sent) * 100).toFixed(2)) : 0,
    clickRate: sent ? Number((((summary.clicks || 0) / sent) * 100).toFixed(2)) : 0,
    bounceRate: sent ? Number((((summary.bounces || 0) / sent) * 100).toFixed(2)) : 0,
    complaintRate: sent ? Number((((summary.complaints || 0) / sent) * 100).toFixed(2)) : 0,
    unsubscribeRate: sent
      ? Number((((summary.unsubscribeCount || 0) / sent) * 100).toFixed(2))
      : 0,
    deliveryRate: sent ? Number(((((delivered || 0) / sent) * 100)).toFixed(2)) : 0,
  };
};

const summarizeEvents = async (match = {}, options = {}) => {
  const [events, hardBounceCount, softBounceCount] = await Promise.all([
    EmailEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$eventType",
          count: { $sum: 1 },
        },
      },
    ]),
    EmailEvent.countDocuments({
      ...match,
      eventType: "bounce",
      bounceType: "Permanent",
    }),
    EmailEvent.countDocuments({
      ...match,
      eventType: "bounce",
      bounceType: { $in: ["Transient", "Undetermined"] },
    }),
  ]);

  const summary = {
    sent: 0,
    delivered: 0,
    opens: 0,
    clicks: 0,
    bounces: 0,
    complaints: 0,
    unsubscribeCount: 0,
    hardBounceCount,
    softBounceCount,
    rejectCount: 0,
    deliveryDelayCount: 0,
    renderingFailureCount: 0,
    suppressedCount: 0,
  };

  events.forEach((event) => {
    const key = eventCountConfig[event._id];
    if (key) {
      summary[key] = event.count;
    }
  });

  if (options.includeSuppressedCount) {
    summary.suppressedCount = await SuppressionEntry.countDocuments({
      status: "active",
      ...buildDateRangeMatch(options.startDate, options.endDate),
    });
  }

  return normalizeSummary(summary);
};

const buildPresetTrendDays = (startDate, endDate) => {
  const fallbackEnd = endDate ? new Date(endDate) : new Date();
  const fallbackStart = startDate
    ? new Date(startDate)
    : new Date(fallbackEnd.getTime() - 6 * 24 * 60 * 60 * 1000);

  const start = new Date(fallbackStart);
  const end = new Date(fallbackEnd);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const days = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
};

const getUniqueCounts = async (match = {}) => {
  const uniqueEvents = await EmailEvent.aggregate([
    {
      $match: {
        ...match,
        eventType: { $in: ["open", "click"] },
      },
    },
    {
      $group: {
        _id: {
          eventType: "$eventType",
          recipientEmail: "$recipientEmail",
        },
      },
    },
    {
      $group: {
        _id: "$_id.eventType",
        count: { $sum: 1 },
      },
    },
  ]);

  return uniqueEvents.reduce(
    (accumulator, item) => {
      if (item._id === "open") {
        accumulator.uniqueOpens = item.count;
      }

      if (item._id === "click") {
        accumulator.uniqueClicks = item.count;
      }

      return accumulator;
    },
    { uniqueOpens: 0, uniqueClicks: 0 }
  );
};

const getCampaignPerformance = async (match = {}, limit = 5) => {
  const eventSummary = await EmailEvent.aggregate([
    {
      $match: {
        ...match,
        campaignId: { $ne: null },
      },
    },
    {
      $group: {
        _id: "$campaignId",
        sent: { $sum: { $cond: [{ $eq: ["$eventType", "send"] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $eq: ["$eventType", "delivery"] }, 1, 0] } },
        opens: { $sum: { $cond: [{ $eq: ["$eventType", "open"] }, 1, 0] } },
        clicks: { $sum: { $cond: [{ $eq: ["$eventType", "click"] }, 1, 0] } },
        bounces: { $sum: { $cond: [{ $eq: ["$eventType", "bounce"] }, 1, 0] } },
        complaints: { $sum: { $cond: [{ $eq: ["$eventType", "complaint"] }, 1, 0] } },
        unsubscribes: { $sum: { $cond: [{ $eq: ["$eventType", "unsubscribe"] }, 1, 0] } },
        rejects: { $sum: { $cond: [{ $eq: ["$eventType", "reject"] }, 1, 0] } },
      },
    },
  ]);

  const campaignIds = eventSummary.map((item) => item._id);
  const campaigns = await EmailCampaign.find({ _id: { $in: campaignIds } }).select(
    "name status type goal sentAt scheduledAt"
  );
  const campaignMap = new Map(campaigns.map((campaign) => [String(campaign._id), campaign]));

  const items = eventSummary
    .map((item) => {
      const campaign = campaignMap.get(String(item._id));

      if (!campaign) {
        return null;
      }

      const summary = normalizeSummary({
        sent: item.sent,
        delivered: item.delivered,
        opens: item.opens,
        clicks: item.clicks,
        bounces: item.bounces,
        complaints: item.complaints,
        unsubscribeCount: item.unsubscribes,
        rejectCount: item.rejects,
      });

      const performanceScore = Number(
        Math.max(
          0,
          summary.openRate * 0.4 +
            summary.clickRate * 0.55 -
            summary.bounceRate * 2 -
            summary.complaintRate * 5 -
            summary.unsubscribeRate * 1.5
        ).toFixed(2)
      );

      return {
        _id: campaign._id,
        name: campaign.name,
        status: campaign.status,
        type: campaign.type,
        goal: campaign.goal,
        sentAt: campaign.sentAt,
        scheduledAt: campaign.scheduledAt,
        ...summary,
        performanceScore,
      };
    })
    .filter(Boolean);

  const topCampaigns = [...items]
    .sort((left, right) => right.performanceScore - left.performanceScore)
    .slice(0, limit);

  const worstCampaign =
    [...items]
      .filter((item) => item.sent > 0)
      .sort((left, right) => left.performanceScore - right.performanceScore)[0] || null;

  return {
    topCampaigns,
    topCampaign: topCampaigns[0] || null,
    worstCampaign,
    campaignRows: items.sort((left, right) => right.sent - left.sent),
  };
};

const getTrendData = async (match = {}, startDate, endDate) => {
  const trendRows = await EmailEvent.aggregate([
    { $match: match },
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
  ]);

  const map = new Map();

  trendRows.forEach((row) => {
    const day = row._id.day;
    if (!map.has(day)) {
      map.set(day, {
        date: day,
        sent: 0,
        delivered: 0,
        opens: 0,
        clicks: 0,
        complaints: 0,
      });
    }

    const current = map.get(day);
    if (row._id.eventType === "send") current.sent = row.count;
    if (row._id.eventType === "delivery") current.delivered = row.count;
    if (row._id.eventType === "open") current.opens = row.count;
    if (row._id.eventType === "click") current.clicks = row.count;
    if (row._id.eventType === "complaint") current.complaints = row.count;
  });

  return buildPresetTrendDays(startDate, endDate).map((day) => ({
    date: day,
    sent: map.get(day)?.sent || 0,
    delivered: map.get(day)?.delivered || 0,
    opens: map.get(day)?.opens || 0,
    clicks: map.get(day)?.clicks || 0,
    complaints: map.get(day)?.complaints || 0,
  }));
};

const getTopLinks = async (match = {}) => {
  const clickEvents = await EmailEvent.find({
    ...match,
    eventType: "click",
  })
    .sort({ timestamp: -1 })
    .limit(200)
    .lean();

  const linkMap = new Map();

  clickEvents.forEach((event) => {
    const link =
      event.clickedLink ||
      event.rawPayload?.click?.link ||
      event.rawPayload?.link ||
      event.rawPayload?.url ||
      event.rawPayload?.linkUrl;

    if (!link) {
      return;
    }

    const current = linkMap.get(link) || {
      url: link,
      totalClicks: 0,
      uniqueClicks: 0,
      emails: new Set(),
    };
    current.totalClicks += 1;
    current.emails.add(event.recipientEmail);
    linkMap.set(link, current);
  });

  return [...linkMap.values()]
    .map((item) => ({
      url: item.url,
      totalClicks: item.totalClicks,
      uniqueClicks: item.emails.size,
    }))
    .sort((left, right) => right.totalClicks - left.totalClicks)
    .slice(0, 5);
};

const buildSenderHealth = (summary) => {
  const riskScore =
    summary.bounceRate * 2.2 +
    summary.complaintRate * 8 +
    summary.unsubscribeRate * 1.5 +
    (summary.deliveryDelayCount > 0 ? 3 : 0) +
    (summary.renderingFailureCount > 0 ? 4 : 0);
  const score = Math.max(0, Math.min(100, Number((100 - riskScore).toFixed(1))));

  if (
    summary.complaintRate >= 0.3 ||
    summary.bounceRate >= 2 ||
    summary.renderingFailureCount > 0
  ) {
    return {
      score,
      state: "critical",
      label: "Critical",
      message:
        "Complaint pressure, bounce levels, or rendering issues need immediate review before the next send.",
    };
  }

  if (
    summary.complaintRate >= 0.1 ||
    summary.bounceRate >= 1 ||
    summary.unsubscribeRate >= 0.5 ||
    summary.deliveryDelayCount > 0
  ) {
    return {
      score,
      state: "warning",
      label: "Warning",
      message:
        "Sender health is still usable, but list hygiene and campaign targeting should be tightened.",
    };
  }

  return {
    score,
    state: "good",
    label: "Good",
    message: "Core deliverability signals are healthy and operational risk is currently low.",
  };
};

const getRecentEventsList = async (match = {}, limit = 6) =>
  EmailEvent.find(match)
    .populate({ path: "campaignId", select: "name" })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();

const getOverviewAnalytics = async (req, res) => {
  const match = buildDateRangeMatch(req.query.startDate, req.query.endDate, "timestamp");
  const [
    summary,
    uniqueCounts,
    topLinks,
    recentEvents,
    campaignPerformance,
    unsubscribeCount,
    trendData,
  ] = await Promise.all([
    summarizeEvents(match),
    getUniqueCounts(match),
    getTopLinks(match),
    getRecentEventsList(match),
    getCampaignPerformance(match, 5),
    SuppressionEntry.countDocuments({
      reason: "unsubscribe",
      status: "active",
      ...buildDateRangeMatch(req.query.startDate, req.query.endDate),
    }),
    getTrendData(match, req.query.startDate, req.query.endDate),
  ]);

  return res.json({
    totalSent: summary.sent,
    delivered: summary.delivered,
    opens: summary.opens,
    uniqueOpens: uniqueCounts.uniqueOpens,
    clicks: summary.clicks,
    uniqueClicks: uniqueCounts.uniqueClicks,
    bounceRate: summary.bounceRate,
    complaintRate: summary.complaintRate,
    unsubscribeCount,
    conversionCount: 0,
    revenueGenerated: 0,
    sendingHealth: buildSenderHealth(summary),
    topCampaign: campaignPerformance.topCampaign,
    worstCampaign: campaignPerformance.worstCampaign,
    topCampaigns: campaignPerformance.topCampaigns,
    trendData,
    topLinks,
    recentEvents,
  });
};

const getAnalyticsSummary = async (req, res) => {
  const match = buildDateRangeMatch(req.query.startDate, req.query.endDate, "timestamp");
  const summary = await summarizeEvents(match);

  const campaignsCount = await EmailCampaign.countDocuments();
  const suppressionsCount = await SuppressionEntry.countDocuments(
    buildDateRangeMatch(req.query.startDate, req.query.endDate)
  );

  return res.json({
    ...summary,
    campaignsCount,
    suppressionsCount,
  });
};

const getDeliverabilitySummary = async (req, res) => {
  const match = buildDateRangeMatch(req.query.startDate, req.query.endDate, "timestamp");
  const summary = await summarizeEvents(match, {
    includeSuppressedCount: true,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  });

  return res.json(summary);
};

const getBounceComplaintBreakdown = async (req, res) => {
  const match = buildDateRangeMatch(req.query.startDate, req.query.endDate, "timestamp");

  const [bounceSubtypeRows, complaintFeedbackRows, complaintTrend] = await Promise.all([
    EmailEvent.aggregate([
      {
        $match: {
          ...match,
          eventType: "bounce",
        },
      },
      {
        $group: {
          _id: {
            bounceType: "$bounceType",
            bounceSubType: "$bounceSubType",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]),
    EmailEvent.aggregate([
      {
        $match: {
          ...match,
          eventType: "complaint",
        },
      },
      {
        $group: {
          _id: "$complaintFeedbackType",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]),
    EmailEvent.aggregate([
      {
        $match: {
          ...match,
          eventType: "complaint",
        },
      },
      {
        $group: {
          _id: {
            day: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$timestamp",
              },
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.day": 1 } },
    ]),
  ]);

  return res.json({
    bounceBreakdown: bounceSubtypeRows.map((row) => ({
      bounceType: row._id.bounceType || "Unknown",
      bounceSubType: row._id.bounceSubType || "Unknown",
      count: row.count,
    })),
    complaintBreakdown: complaintFeedbackRows.map((row) => ({
      feedbackType: row._id || "Unknown",
      count: row.count,
    })),
    complaintTrend: buildPresetTrendDays(req.query.startDate, req.query.endDate).map((day) => ({
      date: day,
      complaints:
        complaintTrend.find((item) => item._id.day === day)?.count || 0,
    })),
  });
};

const getCampaignDeliverability = async (req, res) => {
  const match = buildDateRangeMatch(req.query.startDate, req.query.endDate, "timestamp");
  const search = req.query.search?.trim();
  const status = req.query.status?.trim();
  const { campaignRows } = await getCampaignPerformance(match, 50);

  const filteredRows = campaignRows.filter((row) => {
    if (status && row.status !== status) {
      return false;
    }

    if (search && !row.name.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }

    return true;
  });

  return res.json({
    data: filteredRows,
    totals: {
      campaigns: filteredRows.length,
      activeIssues: filteredRows.filter(
        (row) => row.bounceRate >= 2 || row.complaintRate >= 0.3
      ).length,
    },
  });
};

const getSenderHealthSummary = async (req, res) => {
  const match = buildDateRangeMatch(req.query.startDate, req.query.endDate, "timestamp");
  const summary = await summarizeEvents(match, {
    includeSuppressedCount: true,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  });
  const senderHealth = buildSenderHealth(summary);

  return res.json({
    ...senderHealth,
    metrics: {
      bounceRate: summary.bounceRate,
      complaintRate: summary.complaintRate,
      unsubscribeRate: summary.unsubscribeRate,
      deliveryRate: summary.deliveryRate,
      suppressedCount: summary.suppressedCount,
    },
    domainHealth: {
      state: "future_ready",
      label: "Pending DNS telemetry",
      message: "Domain authentication and inbox placement diagnostics can plug in here later.",
    },
    ispStats: [],
    recommendations: [
      summary.bounceRate >= 1
        ? "Review list quality and recent imports before the next blast."
        : "Bounce pressure is currently within a healthy range.",
      summary.complaintRate >= 0.1
        ? "Refresh content targeting and send only to recently engaged segments."
        : "Complaint pressure is currently low.",
      summary.unsubscribeRate >= 0.5
        ? "Consider reducing send frequency for colder segments."
        : "Unsubscribe pressure is stable.",
    ],
  });
};

const getRecentEvents = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const search = req.query.search?.trim();

  const match = {
    ...buildDateRangeMatch(req.query.startDate, req.query.endDate, "timestamp"),
  };

  if (search) {
    match.recipientEmail = new RegExp(escapeRegExp(search), "i");
  }

  const [events, total] = await Promise.all([
    EmailEvent.find(match)
      .populate({ path: "campaignId", select: "name" })
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    EmailEvent.countDocuments(match),
  ]);

  return res.json({
    data: events,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
};

const getTopCampaigns = async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20);
  const match = buildDateRangeMatch(req.query.startDate, req.query.endDate, "timestamp");
  const { topCampaigns } = await getCampaignPerformance(match, limit);

  return res.json(topCampaigns);
};

export {
  getOverviewAnalytics,
  getAnalyticsSummary,
  getDeliverabilitySummary,
  getBounceComplaintBreakdown,
  getCampaignDeliverability,
  getSenderHealthSummary,
  getRecentEvents,
  getTopCampaigns,
};
