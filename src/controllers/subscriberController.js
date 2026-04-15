import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailEvent from "../models/EmailEvent.js";
import Subscriber, {
  subscriberSources,
  subscriberStatuses,
} from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { triggerWorkflowExecutions } from "../services/automationService.js";
import { buildSubscriberMatch } from "../utils/subscriberFilters.js";

const normalizeTags = (tags = []) =>
  Array.from(
    new Set(
      (Array.isArray(tags) ? tags : String(tags).split(","))
        .map((tag) => String(tag).trim())
        .filter(Boolean),
    ),
  );

const normalizeCustomFields = (customFields = {}) => {
  if (!customFields) {
    return {};
  }

  if (typeof customFields === "string") {
    try {
      return JSON.parse(customFields);
    } catch {
      return {};
    }
  }

  return customFields;
};

const calculateEngagementSummary = (payload) => {
  const lastActivityAt =
    payload.lastClickAt ||
    payload.lastOpenAt ||
    payload.lastEmailSentAt ||
    payload.lastOrderDate ||
    null;

  const score =
    Number(payload.totalOrders || 0) * 18 +
    Number(payload.totalSpent || 0) * 0.08 +
    (payload.lastOpenAt ? 8 : 0) +
    (payload.lastClickAt ? 16 : 0);

  return {
    lastActivityAt,
    engagementScore: Math.round(score),
  };
};

const normalizeSubscriberPayload = (payload) => {
  const normalized = {
    firstName: payload.firstName?.trim(),
    lastName: payload.lastName?.trim(),
    email: payload.email?.trim().toLowerCase(),
    phone: payload.phone?.trim() || "",
    status: payload.status,
    source: payload.source || "manual",
    tags: normalizeTags(payload.tags),
    city: payload.city?.trim() || "",
    state: payload.state?.trim() || "",
    country: payload.country?.trim() || "",
    totalOrders: Number(payload.totalOrders || 0),
    totalSpent: Number(payload.totalSpent || 0),
    lastOrderDate: payload.lastOrderDate || null,
    lastEmailSentAt: payload.lastEmailSentAt || null,
    lastOpenAt: payload.lastOpenAt || null,
    lastClickAt: payload.lastClickAt || null,
    notes: payload.notes?.trim() || "",
    customFields: normalizeCustomFields(payload.customFields),
  };

  return {
    ...normalized,
    ...calculateEngagementSummary(normalized),
  };
};

const getSubscriberErrorMessage = (error, fallbackMessage) => {
  if (error?.name === "ValidationError") {
    const messages = Object.values(error.errors || {})
      .map((item) => item.message)
      .filter(Boolean);

    if (messages.length) {
      return messages.join(", ");
    }
  }

  if (error?.name === "CastError") {
    return `Invalid value for ${error.path}`;
  }

  if (error?.message) {
    return error.message;
  }

  return fallbackMessage;
};

const parseCsv = (content = "") => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(",").map((value) => value.trim());

  return lines.slice(1).map((line) => {
    const values = line.split(",").map((value) => value.trim());
    return headers.reduce((accumulator, header, index) => {
      accumulator[header] = values[index] || "";
      return accumulator;
    }, {});
  });
};

const buildDetailPayload = async (subscriber) => {
  if (!subscriber) {
    return null;
  }

  const [recentEmailEvents, campaignHistory, suppressionEntry] =
    await Promise.all([
      EmailEvent.find({ recipientEmail: subscriber.email })
        .sort({ timestamp: -1 })
        .limit(12)
        .select(
          "eventType timestamp clickedLink bounceType complaintFeedbackType deviceType",
        )
        .lean(),
      CampaignRecipient.find({ email: subscriber.email })
        .sort({ updatedAt: -1 })
        .limit(12)
        .populate({ path: "campaignId", select: "name status subject" })
        .lean(),
      SuppressionEntry.findOne({ email: subscriber.email }).lean(),
    ]);

  return {
    ...subscriber.toObject(),
    campaignHistory,
    recentEmailEvents,
    suppressionStatus: suppressionEntry
      ? {
          isSuppressed: true,
          reason: suppressionEntry.reason,
          source: suppressionEntry.source,
          updatedAt: suppressionEntry.updatedAt,
        }
      : {
          isSuppressed: false,
        },
  };
};

const getSubscriberMeta = async (_req, res) =>
  res.json({
    statuses: subscriberStatuses,
    sources: subscriberSources,
  });

const getSubscriberSummary = async (_req, res) => {
  try {
    const [statusCounts, sourceCounts, totals] = await Promise.all([
      Subscriber.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Subscriber.aggregate([
        { $group: { _id: "$source", count: { $sum: 1 } } },
      ]),
      Subscriber.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            averageEngagementScore: { $avg: "$engagementScore" },
            totalOrders: { $sum: "$totalOrders" },
            totalSpent: { $sum: "$totalSpent" },
          },
        },
      ]),
    ]);

    const byStatus = statusCounts.reduce((accumulator, item) => {
      accumulator[item._id] = item.count;
      return accumulator;
    }, {});

    const bySource = sourceCounts
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((item) => ({
        source: item._id,
        count: item.count,
      }));

    const total = totals[0]?.total || 0;

    return res.json({
      total,
      byStatus,
      bySource,
      averageEngagementScore: Math.round(
        totals[0]?.averageEngagementScore || 0,
      ),
      totalOrders: totals[0]?.totalOrders || 0,
      totalSpent: Number(totals[0]?.totalSpent || 0),
      activeCount: byStatus.subscribed || 0,
      riskCount:
        (byStatus.unsubscribed || 0) +
        (byStatus.bounced || 0) +
        (byStatus.complained || 0) +
        (byStatus.suppressed || 0),
    });
  } catch (error) {
    console.error("Unable to load subscriber summary", error);
    return res.json({
      total: 0,
      byStatus: {},
      bySource: [],
      averageEngagementScore: 0,
      totalOrders: 0,
      totalSpent: 0,
      activeCount: 0,
      riskCount: 0,
    });
  }
};

const listSubscribers = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const match = buildSubscriberMatch(req.query);

  const [subscribers, total] = await Promise.all([
    Subscriber.find(match)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Subscriber.countDocuments(match),
  ]);

  return res.json({
    data: subscribers,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
};

const filterSubscribers = async (req, res) => {
  const page = Math.max(Number(req.body.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.body.limit) || 10, 1), 100);
  const match = buildSubscriberMatch(req.body);

  const [subscribers, total] = await Promise.all([
    Subscriber.find(match)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Subscriber.countDocuments(match),
  ]);

  return res.json({
    data: subscribers,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
};

const getSubscriberById = async (req, res) => {
  const subscriber = await Subscriber.findById(req.params.id);

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  return res.json(await buildDetailPayload(subscriber));
};

const createSubscriber = async (req, res) => {
  try {
    const subscriber = await Subscriber.create(
      normalizeSubscriberPayload(req.body),
    );

    triggerWorkflowExecutions({
      trigger: "welcome_signup",
      subscriberId: subscriber._id,
      context: {
        source: "subscriber.created",
      },
    }).catch((error) => {
      console.error("Unable to trigger welcome_signup automation", error);
    });

    return res.status(201).json(subscriber);
  } catch (error) {
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ message: "Subscriber email already exists" });
    }

    return res.status(400).json({
      message: getSubscriberErrorMessage(error, "Unable to create subscriber"),
    });
  }
};

const updateSubscriber = async (req, res) => {
  try {
    const subscriber = await Subscriber.findByIdAndUpdate(
      req.params.id,
      normalizeSubscriberPayload(req.body),
      {
        returnDocument: "after",
        runValidators: true,
      },
    );

    if (!subscriber) {
      return res.status(404).json({ message: "Subscriber not found" });
    }

    return res.json(subscriber);
  } catch (error) {
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ message: "Subscriber email already exists" });
    }

    return res.status(400).json({
      message: getSubscriberErrorMessage(error, "Unable to update subscriber"),
    });
  }
};

const deleteSubscriber = async (req, res) => {
  const subscriber = await Subscriber.findByIdAndDelete(req.params.id);

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  return res.json({ message: "Subscriber deleted" });
};

const bulkTagSubscribers = async (req, res) => {
  const subscriberIds = req.body.subscriberIds || [];
  const tags = normalizeTags(req.body.tags);

  if (!subscriberIds.length || !tags.length) {
    return res
      .status(400)
      .json({ message: "Subscriber ids and tags are required" });
  }

  await Subscriber.updateMany(
    { _id: { $in: subscriberIds } },
    { $addToSet: { tags: { $each: tags } } },
  );

  return res.json({
    message: "Tags assigned",
    updatedCount: subscriberIds.length,
  });
};

const bulkUnsubscribeSubscribers = async (req, res) => {
  const subscriberIds = req.body.subscriberIds || [];

  if (!subscriberIds.length) {
    return res.status(400).json({ message: "Subscriber ids are required" });
  }

  const subscribers = await Subscriber.find({ _id: { $in: subscriberIds } });

  await Subscriber.updateMany(
    { _id: { $in: subscriberIds } },
    { status: "unsubscribed" },
  );

  await Promise.all(
    subscribers.map((subscriber) =>
      SuppressionEntry.findOneAndUpdate(
        { email: subscriber.email },
        {
          email: subscriber.email,
          reason: "unsubscribe",
          source: "admin",
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      ),
    ),
  );

  return res.json({
    message: "Subscribers unsubscribed",
    updatedCount: subscriberIds.length,
  });
};

const bulkSuppressSubscribers = async (req, res) => {
  const subscriberIds = req.body.subscriberIds || [];

  if (!subscriberIds.length) {
    return res.status(400).json({ message: "Subscriber ids are required" });
  }

  const subscribers = await Subscriber.find({ _id: { $in: subscriberIds } });

  await Subscriber.updateMany(
    { _id: { $in: subscriberIds } },
    { status: "suppressed" },
  );

  await Promise.all(
    subscribers.map((subscriber) =>
      SuppressionEntry.findOneAndUpdate(
        { email: subscriber.email },
        {
          email: subscriber.email,
          reason: "manual",
          source: "admin",
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      ),
    ),
  );

  return res.json({
    message: "Subscribers suppressed",
    updatedCount: subscriberIds.length,
  });
};

const bulkReactivateSubscribers = async (req, res) => {
  const subscriberIds = req.body.subscriberIds || [];

  if (!subscriberIds.length) {
    return res.status(400).json({ message: "Subscriber ids are required" });
  }

  const subscribers = await Subscriber.find({ _id: { $in: subscriberIds } });
  const emails = subscribers.map((subscriber) => subscriber.email);

  await Subscriber.updateMany(
    { _id: { $in: subscriberIds } },
    { status: "subscribed" },
  );

  if (emails.length) {
    await SuppressionEntry.deleteMany({ email: { $in: emails } });
  }

  return res.json({
    message: "Subscribers reactivated",
    updatedCount: subscriberIds.length,
  });
};

const importSubscribersFromCsv = async (req, res) => {
  const rows = parseCsv(req.body.csvContent || "");

  if (!rows.length) {
    return res.status(400).json({ message: "CSV content is empty or invalid" });
  }

  let importedCount = 0;
  let updatedCount = 0;

  for (const row of rows) {
    const payload = normalizeSubscriberPayload({
      ...row,
      source: row.source || "admin_import",
      tags: row.tags || "",
    });

    const existing = await Subscriber.findOne({ email: payload.email });

    if (existing) {
      await Subscriber.findByIdAndUpdate(existing._id, payload, {
        returnDocument: "after",
        runValidators: true,
      });
      updatedCount += 1;
    } else {
      await Subscriber.create(payload);
      importedCount += 1;
    }
  }

  return res.json({
    message: "CSV import completed",
    importedCount,
    updatedCount,
  });
};

export {
  bulkSuppressSubscribers,
  bulkReactivateSubscribers,
  bulkTagSubscribers,
  bulkUnsubscribeSubscribers,
  createSubscriber,
  deleteSubscriber,
  filterSubscribers,
  getSubscriberById,
  getSubscriberMeta,
  getSubscriberSummary,
  importSubscribersFromCsv,
  listSubscribers,
  updateSubscriber,
};
