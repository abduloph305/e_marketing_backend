import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailCampaign from "../models/EmailCampaign.js";
import EmailEvent from "../models/EmailEvent.js";
import IntegrationEvent from "../models/IntegrationEvent.js";
import Subscriber from "../models/Subscriber.js";
import { buildDateRangeMatch } from "../utils/dateRange.js";

const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const normalizeNumber = (value = 0) => Number(Number(value || 0).toFixed(2));

const buildWindowMatch = (window = {}, field = "createdAt") =>
  buildDateRangeMatch(window.startDate?.toISOString(), window.endDate?.toISOString(), field);

const summarizeEmailEvents = async (match = {}) => {
  const [rows, hardBounces, softBounces, uniqueRows] = await Promise.all([
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
    EmailEvent.aggregate([
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
    ]),
  ]);

  const summary = {
    sent: 0,
    delivered: 0,
    opens: 0,
    clicks: 0,
    bounces: 0,
    complaints: 0,
    unsubscribes: 0,
    hardBounceCount: hardBounces,
    softBounceCount: softBounces,
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

  const uniqueMap = uniqueRows.reduce(
    (accumulator, row) => {
      if (row._id === "open") {
        accumulator.uniqueOpens = row.count;
      }

      if (row._id === "click") {
        accumulator.uniqueClicks = row.count;
      }

      return accumulator;
    },
    { uniqueOpens: 0, uniqueClicks: 0 },
  );

  const openRate = summary.sent ? normalizeNumber((summary.opens / summary.sent) * 100) : 0;
  const clickRate = summary.sent ? normalizeNumber((summary.clicks / summary.sent) * 100) : 0;
  const bounceRate = summary.sent ? normalizeNumber((summary.bounces / summary.sent) * 100) : 0;
  const complaintRate = summary.sent ? normalizeNumber((summary.complaints / summary.sent) * 100) : 0;
  const unsubscribeRate = summary.sent ? normalizeNumber((summary.unsubscribes / summary.sent) * 100) : 0;
  const deliveryRate = summary.sent ? normalizeNumber((summary.delivered / summary.sent) * 100) : 0;
  const ctor = uniqueMap.uniqueOpens
    ? normalizeNumber((uniqueMap.uniqueClicks / uniqueMap.uniqueOpens) * 100)
    : 0;

  return {
    ...summary,
    ...uniqueMap,
    openRate,
    clickRate,
    bounceRate,
    complaintRate,
    unsubscribeRate,
    deliveryRate,
    ctor,
  };
};

const getConversionSummary = async (window = {}) => {
  const convertedMatch = {
    convertedAt: { $ne: null },
    ...buildWindowMatch(window, "convertedAt"),
  };

  const [attributedRows, commerceRows, campaignCostRows] = await Promise.all([
    CampaignRecipient.aggregate([
      { $match: convertedMatch },
      {
        $group: {
          _id: null,
          conversions: { $sum: { $ifNull: ["$conversionCount", 1] } },
          uniqueConversions: { $sum: 1 },
          revenueGenerated: { $sum: { $ifNull: ["$revenueAttributed", 0] } },
        },
      },
    ]),
    IntegrationEvent.aggregate([
      {
        $match: {
          ...buildWindowMatch(window, "createdAt"),
          eventType: { $in: ["order.completed", "payment.success"] },
        },
      },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          revenue: {
            $sum: {
              $convert: {
                input: "$payload.amount",
                to: "double",
                onError: 0,
                onNull: 0,
              },
            },
          },
        },
      },
    ]),
    EmailCampaign.aggregate([
      { $match: buildWindowMatch(window, "sentAt") },
      {
        $group: {
          _id: null,
          totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
        },
      },
    ]),
  ]);

  const attributed = attributedRows[0] || {};
  const commerce = commerceRows[0] || {};
  const totalCost = campaignCostRows[0]?.totalCost || 0;
  const conversions = attributed.conversions || commerce.orders || 0;
  const uniqueConversions = attributed.uniqueConversions || commerce.orders || 0;
  const revenueGenerated = attributed.revenueGenerated || commerce.revenue || 0;

  return {
    conversionCount: conversions,
    uniqueConversionCount: uniqueConversions,
    conversionRate: conversions
      ? normalizeNumber((conversions / Math.max(commerce.orders || conversions, 1)) * 100)
      : 0,
    revenueGenerated: normalizeNumber(revenueGenerated),
    totalCost: normalizeNumber(totalCost),
    profit: normalizeNumber(revenueGenerated - totalCost),
    roiPercent: totalCost > 0 ? normalizeNumber(((revenueGenerated - totalCost) / totalCost) * 100) : null,
    averageOrderValue: conversions ? normalizeNumber(revenueGenerated / conversions) : 0,
    attributedConversions: attributed.conversions || 0,
    attributedRevenue: normalizeNumber(attributed.revenueGenerated || 0),
    commerceOrders: commerce.orders || 0,
    commerceRevenue: normalizeNumber(commerce.revenue || 0),
  };
};

const getListGrowthSummary = async (window = {}) => {
  const [newSubscribers, unsubscribes, priorAudience, currentAudience] = await Promise.all([
    Subscriber.countDocuments(buildWindowMatch(window, "createdAt")),
    EmailEvent.countDocuments({
      ...buildWindowMatch(window, "timestamp"),
      eventType: "unsubscribe",
    }),
    window.startDate
      ? Subscriber.countDocuments({
          createdAt: { $lt: window.startDate },
        })
      : Promise.resolve(0),
    window.endDate
      ? Subscriber.countDocuments({
          createdAt: { $lte: window.endDate },
        })
      : Subscriber.countDocuments({}),
  ]);

  const netGrowth = newSubscribers - unsubscribes;
  const growthRate = priorAudience > 0 ? normalizeNumber((netGrowth / priorAudience) * 100) : 0;

  return {
    startingAudience: priorAudience,
    endingAudience: currentAudience,
    newSubscribers,
    unsubscribes,
    netGrowth,
    growthRate,
  };
};

const getDeviceBreakdown = async (window = {}) => {
  const rows = await EmailEvent.aggregate([
    {
      $match: {
        ...buildWindowMatch(window, "timestamp"),
        eventType: { $in: ["open", "click"] },
      },
    },
    {
      $group: {
        _id: {
          $cond: [
            { $and: [{ $ne: ["$deviceType", null] }, { $ne: ["$deviceType", ""] }] },
            "$deviceType",
            "unknown",
          ],
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const total = rows.reduce((sum, row) => sum + (row.count || 0), 0);

  return rows.map((row) => ({
    deviceType: row._id || "unknown",
    count: row.count || 0,
    share: total ? normalizeNumber((row.count / total) * 100) : 0,
  }));
};

const normalizeLocation = (value = "") => String(value || "").trim() || "Unknown";

const getLocationBreakdown = async (window = {}) => {
  const subscriberMatch = buildWindowMatch(window, "createdAt");
  const [countryRows, stateRows, cityRows, eventCountryRows] = await Promise.all([
    Subscriber.aggregate([
      { $match: subscriberMatch },
      {
        $group: {
          _id: { $cond: [{ $ne: ["$country", ""] }, "$country", "Unknown"] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    Subscriber.aggregate([
      { $match: subscriberMatch },
      {
        $group: {
          _id: { $cond: [{ $ne: ["$state", ""] }, "$state", "Unknown"] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    Subscriber.aggregate([
      { $match: subscriberMatch },
      {
        $group: {
          _id: { $cond: [{ $ne: ["$city", ""] }, "$city", "Unknown"] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    EmailEvent.aggregate([
      {
        $match: {
          ...buildWindowMatch(window, "timestamp"),
          eventType: { $in: ["open", "click"] },
        },
      },
      {
        $group: {
          _id: {
            $cond: [
              { $and: [{ $ne: ["$geo.country", null] }, { $ne: ["$geo.country", ""] }] },
              "$geo.country",
              "Unknown",
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const mapRows = (rows = []) => {
    const total = rows.reduce((sum, row) => sum + (row.count || 0), 0);
    return rows.map((row) => ({
      label: normalizeLocation(row._id),
      count: row.count || 0,
      share: total ? normalizeNumber((row.count / total) * 100) : 0,
    }));
  };

  return {
    countries: mapRows(countryRows),
    states: mapRows(stateRows),
    cities: mapRows(cityRows),
    eventCountries: mapRows(eventCountryRows),
  };
};

const getTimeBasedAnalytics = async (window = {}) => {
  const rows = await EmailEvent.aggregate([
    {
      $match: {
        ...buildWindowMatch(window, "timestamp"),
        eventType: { $in: ["open", "click"] },
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
          hour: { $hour: "$timestamp" },
          weekday: { $dayOfWeek: "$timestamp" },
          eventType: "$eventType",
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.day": 1, "_id.hour": 1 } },
  ]);

  const dailyMap = new Map();
  const hourlyMap = new Map();
  const weekdayMap = new Map();

  rows.forEach((row) => {
    const { day, hour, weekday, eventType } = row._id;

    if (!dailyMap.has(day)) {
      dailyMap.set(day, { date: day, opens: 0, clicks: 0, total: 0 });
    }

    if (!hourlyMap.has(hour)) {
      hourlyMap.set(hour, { hour, opens: 0, clicks: 0, total: 0 });
    }

    if (!weekdayMap.has(weekday)) {
      weekdayMap.set(weekday, {
        weekday,
        label: DAY_LABELS[weekday - 1] || "Unknown",
        opens: 0,
        clicks: 0,
        total: 0,
      });
    }

    const daily = dailyMap.get(day);
    const hourly = hourlyMap.get(hour);
    const weekdayBucket = weekdayMap.get(weekday);

    daily.total += row.count;
    hourly.total += row.count;
    weekdayBucket.total += row.count;

    if (eventType === "open") {
      daily.opens += row.count;
      hourly.opens += row.count;
      weekdayBucket.opens += row.count;
    }

    if (eventType === "click") {
      daily.clicks += row.count;
      hourly.clicks += row.count;
      weekdayBucket.clicks += row.count;
    }
  });

  const daily = [...dailyMap.values()];
  const hourly = Array.from({ length: 24 }, (_, hour) => hourlyMap.get(hour) || { hour, opens: 0, clicks: 0, total: 0 });
  const weekday = Array.from({ length: 7 }, (_, index) => weekdayMap.get(index + 1) || {
    weekday: index + 1,
    label: DAY_LABELS[index],
    opens: 0,
    clicks: 0,
    total: 0,
  });

  const bestHour = [...hourly].sort((left, right) => right.total - left.total)[0] || null;
  const bestDay = [...weekday].sort((left, right) => right.total - left.total)[0] || null;

  return {
    daily,
    hourly,
    weekday,
    bestHour,
    bestDay,
  };
};

const getAnalyticsSnapshot = async (query = {}) => {
  const window = {
    startDate: query.startDate ? new Date(query.startDate) : null,
    endDate: query.endDate ? new Date(query.endDate) : null,
  };

  if (window.startDate && Number.isNaN(window.startDate.getTime())) {
    window.startDate = null;
  }

  if (window.endDate && Number.isNaN(window.endDate.getTime())) {
    window.endDate = null;
  }

  const [summary, conversion, listGrowth, deviceBreakdown, locationBreakdown, timeBasedAnalytics] = await Promise.all([
    summarizeEmailEvents(buildWindowMatch(window, "timestamp")),
    getConversionSummary(window),
    getListGrowthSummary(window),
    getDeviceBreakdown(window),
    getLocationBreakdown(window),
    getTimeBasedAnalytics(window),
  ]);

  return {
    window,
    summary,
    conversion,
    listGrowth,
    deviceBreakdown,
    locationBreakdown,
    timeBasedAnalytics,
  };
};

export {
  getAnalyticsSnapshot,
  getConversionSummary,
  getDeviceBreakdown,
  getListGrowthSummary,
  getLocationBreakdown,
  getTimeBasedAnalytics,
  summarizeEmailEvents,
};
