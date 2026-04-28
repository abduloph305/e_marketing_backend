import EmailCampaign from "../models/EmailCampaign.js";
import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import {
  getConversionSummary,
  getDeviceBreakdown,
  getListGrowthSummary,
  getLocationBreakdown,
  getTimeBasedAnalytics,
  summarizeEmailEvents,
} from "../services/analyticsService.js";
import { buildDateRangeMatch } from "../utils/dateRange.js";
import { buildVendorMatch } from "../utils/vendorScope.js";

const summarizeEvents = async (match = {}) => {
  return summarizeEmailEvents(match);
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

const getRangeSummary = async (window, scopeMatch = {}) => {
  const [events, campaigns, subscribers, suppressions, conversion, growth] = await Promise.all([
    summarizeEvents({ ...scopeMatch, ...buildWindowMatch(window, "timestamp") }),
    EmailCampaign.countDocuments({ ...scopeMatch, ...buildWindowMatch(window) }),
    Subscriber.countDocuments({ ...scopeMatch, ...buildWindowMatch(window) }),
    SuppressionEntry.countDocuments({
      ...scopeMatch,
      status: "active",
      ...buildWindowMatch(window),
    }),
    getConversionSummary(window, scopeMatch),
    getListGrowthSummary(window, scopeMatch),
  ]);

  return {
    campaigns,
    newSubscribers: subscribers,
    suppressions,
    ...events,
    conversionCount: conversion.conversionCount,
    uniqueConversionCount: conversion.uniqueConversionCount,
    conversionRate: conversion.conversionRate,
    revenueGenerated: conversion.revenueGenerated,
    roiPercent: conversion.roiPercent,
    averageOrderValue: conversion.averageOrderValue,
    totalCost: conversion.totalCost,
    profit: conversion.profit,
    attributedConversions: conversion.attributedConversions,
    attributedRevenue: conversion.attributedRevenue,
    commerceOrders: conversion.commerceOrders,
    commerceRevenue: conversion.commerceRevenue,
    startingAudience: growth.startingAudience,
    endingAudience: growth.endingAudience,
    netGrowth: growth.netGrowth,
    growthRate: growth.growthRate,
  };
};

const getCampaignReportRows = async (window = {}, scopeMatch = {}) => {
  const campaigns = await EmailCampaign.find(scopeMatch)
    .select("name status type goal totals totalRecipients estimatedCost sentAt scheduledAt")
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
      estimatedCost: campaign.estimatedCost || 0,
      sent: campaign.totals?.sent || 0,
      delivered: campaign.totals?.delivered || 0,
      opens: campaign.totals?.opens || 0,
      clicks: campaign.totals?.clicks || 0,
      scheduledAt: campaign.scheduledAt,
      sentAt: campaign.sentAt,
    }));
};

const getAudienceGrowthReport = async (window = {}, scopeMatch = {}) => {
  const growth = await Subscriber.aggregate([
    { $match: { ...scopeMatch, ...buildWindowMatch(window) } },
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

const getDeliverabilityReport = async (window = {}, scopeMatch = {}) => {
  const summary = await summarizeEvents({ ...scopeMatch, ...buildWindowMatch(window, "timestamp") });
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
  const scopeMatch = buildVendorMatch(req);
  const [
    dailySummary,
    weeklySummary,
    monthlySummary,
    selectedSummary,
    campaignReport,
    audienceGrowth,
    deliverability,
    deviceBreakdown,
    locationBreakdown,
    timeBasedAnalytics,
  ] = await Promise.all([
    getRangeSummary(resolveReportWindow({ range: "today" }), scopeMatch),
    getRangeSummary(resolveReportWindow({ range: "7d" }), scopeMatch),
    getRangeSummary(resolveReportWindow({ range: "30d" }), scopeMatch),
    getRangeSummary(selectedWindow, scopeMatch),
    getCampaignReportRows(selectedWindow, scopeMatch),
    getAudienceGrowthReport(selectedWindow, scopeMatch),
    getDeliverabilityReport(selectedWindow, scopeMatch),
    getDeviceBreakdown(selectedWindow, scopeMatch),
    getLocationBreakdown(selectedWindow, scopeMatch),
    getTimeBasedAnalytics(selectedWindow, scopeMatch),
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
    deviceBreakdown,
    locationBreakdown,
    timeBasedAnalytics,
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
