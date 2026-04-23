import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailEvent from "../models/EmailEvent.js";
import Subscriber, {
  subscriberSources,
  subscriberStatuses,
} from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { triggerWorkflowExecutions } from "../services/automationService.js";
import { syncWebsiteAudience } from "../services/websiteAudienceSyncService.js";
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

const resolveSourceLocation = (subscriber = {}) => {
  const sourceLocation = String(subscriber.sourceLocation || "").trim();
  if (sourceLocation) {
    return sourceLocation;
  }

  const customSourceLocation = String(
    subscriber.customFields?.audienceSourceLocation ||
      (Array.isArray(subscriber.customFields?.sourceLocations)
        ? subscriber.customFields.sourceLocations[0]
        : "") ||
      "",
  ).trim();

  if (customSourceLocation) {
    return customSourceLocation;
  }

  const source = String(subscriber.source || "").trim();
  if (
    [
      "website_signup",
      "checkout",
      "popup",
      "lead_magnet",
      "referral",
    ].includes(source)
  ) {
    return "main_website";
  }

  if (source === "admin_import") {
    return "admin";
  }

  return source || "manual";
};

const titleCase = (value = "") =>
  String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

const deriveNamesFromEmail = (email = "") => {
  const localPart = String(email).split("@")[0] || "subscriber";
  const nameParts = localPart
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!nameParts.length) {
    return {
      firstName: "Subscriber",
      lastName: "Imported",
    };
  }

  if (nameParts.length === 1) {
    return {
      firstName: titleCase(nameParts[0]),
      lastName: "Subscriber",
    };
  }

  return {
    firstName: titleCase(nameParts[0]),
    lastName: titleCase(nameParts.slice(1).join(" ")) || "Subscriber",
  };
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
  const email = payload.email?.trim().toLowerCase();
  const derivedNames = email ? deriveNamesFromEmail(email) : {};
  const sourceLocation = String(
    payload.sourceLocation ||
      payload.source_location ||
      payload.customFields?.audienceSourceLocation ||
      "manual",
  ).trim();
  const sourceLocations = normalizeTags([
    sourceLocation,
    ...(Array.isArray(payload.customFields?.sourceLocations)
      ? payload.customFields.sourceLocations
      : []),
  ]);
  const normalized = {
    firstName: payload.firstName?.trim() || derivedNames.firstName || "",
    lastName: payload.lastName?.trim() || derivedNames.lastName || "",
    email,
    phone: payload.phone?.trim() || "",
    status: payload.status,
    source: payload.source || "manual",
    sourceLocation,
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
    customFields: {
      ...normalizeCustomFields(payload.customFields),
      sourceLocations,
    },
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
    const singleColumnEmails = lines.filter((line) => line.includes("@"));

    return singleColumnEmails.map((email) => ({ email }));
  }

  const headers = lines[0].split(",").map((value) => value.trim());
  const isEmailOnlyHeader =
    headers.length === 1 && headers[0].toLowerCase() === "email";
  const isSingleColumnEmailList =
    headers.length === 1 && lines[0].includes("@") && lines.length >= 1;

  if (isSingleColumnEmailList) {
    return lines.map((line) => ({ email: line }));
  }

  if (isEmailOnlyHeader) {
    return lines.slice(1).map((line) => ({ email: line.split(",")[0]?.trim() || "" }));
  }

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
    sourceLocation: resolveSourceLocation(subscriber.toObject()),
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

const runBestEffortCleanup = async () => {
  try {
    console.log("[audience] refresh started");
    const result = await syncWebsiteAudience();

    const normalizedComplaints = await Subscriber.updateMany(
      { status: "complained" },
      {
        status: "blocked",
        blockedReason: "spam",
        blockedAt: new Date(),
      },
    );

    console.log("[audience] refresh completed", {
      mainWebsite: result.mainWebsite?.users || 0,
      vendorWebsite: result.vendorWebsite?.users || 0,
      deletedCount: result.deletedCount || 0,
      complaintToBlockedCount: normalizedComplaints.modifiedCount || 0,
    });
  } catch (error) {
    console.warn("Audience sync skipped", error?.message || error);
  }
};

const getSubscriberMeta = async (_req, res) =>
  res.json({
    statuses: subscriberStatuses,
    sources: subscriberSources,
  });

const getSubscriberSummary = async (_req, res) => {
  try {
    await runBestEffortCleanup();

    const [statusCounts, totals, sourceDocs] = await Promise.all([
      Subscriber.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
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
      Subscriber.find({})
        .select("source sourceLocation customFields")
        .lean(),
    ]);

    const byStatus = statusCounts.reduce((accumulator, item) => {
      accumulator[item._id] = item.count;
      return accumulator;
    }, {});

    const bySourceCounts = sourceDocs.reduce((accumulator, subscriber) => {
      const key = resolveSourceLocation(subscriber);
      accumulator[key] = (accumulator[key] || 0) + 1;
      return accumulator;
    }, {});

    const bySource = Object.entries(bySourceCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((item) => item);

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
        (byStatus.blocked || 0) +
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
  await runBestEffortCleanup();

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
    data: subscribers.map((subscriber) => ({
      ...subscriber.toObject(),
      sourceLocation: resolveSourceLocation(subscriber.toObject()),
    })),
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
    data: subscribers.map((subscriber) => ({
      ...subscriber.toObject(),
      sourceLocation: resolveSourceLocation(subscriber.toObject()),
    })),
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
    const existingSubscriber = await Subscriber.findById(req.params.id).lean();

    if (!existingSubscriber) {
      return res.status(404).json({ message: "Subscriber not found" });
    }

    if (
      existingSubscriber.status === "blocked" &&
      existingSubscriber.blockedReason === "spam" &&
      req.body?.status &&
      req.body.status !== "blocked"
    ) {
      return res.status(403).json({
        message: "Spam-blocked subscribers cannot be unblocked manually",
      });
    }

    const nextPayload = normalizeSubscriberPayload(req.body);

    if (nextPayload.status === "blocked") {
      nextPayload.blockedReason =
        existingSubscriber.status === "blocked"
          ? existingSubscriber.blockedReason || "manual"
          : req.body?.blockedReason || "manual";
      nextPayload.blockedAt =
        existingSubscriber.status === "blocked"
          ? existingSubscriber.blockedAt || new Date()
          : new Date();
    } else if (existingSubscriber.status === "blocked") {
      nextPayload.blockedReason = "";
      nextPayload.blockedAt = null;
    }

    const subscriber = await Subscriber.findByIdAndUpdate(
      req.params.id,
      nextPayload,
      {
        returnDocument: "after",
        runValidators: true,
      },
    );

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
  const eligibleSubscribers = subscribers.filter(
    (subscriber) => !(subscriber.status === "blocked" && subscriber.blockedReason === "spam"),
  );

  await Subscriber.updateMany(
    { _id: { $in: eligibleSubscribers.map((subscriber) => subscriber._id) } },
    { status: "unsubscribed", blockedReason: "", blockedAt: null },
  );

  await Promise.all(
    eligibleSubscribers.map((subscriber) =>
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
    updatedCount: eligibleSubscribers.length,
    skippedCount: subscriberIds.length - eligibleSubscribers.length,
  });
};

const bulkSuppressSubscribers = async (req, res) => {
  const subscriberIds = req.body.subscriberIds || [];

  if (!subscriberIds.length) {
    return res.status(400).json({ message: "Subscriber ids are required" });
  }

  const subscribers = await Subscriber.find({ _id: { $in: subscriberIds } });
  const eligibleSubscribers = subscribers.filter(
    (subscriber) => !(subscriber.status === "blocked" && subscriber.blockedReason === "spam"),
  );

  await Subscriber.updateMany(
    { _id: { $in: eligibleSubscribers.map((subscriber) => subscriber._id) } },
    { status: "suppressed", blockedReason: "", blockedAt: null },
  );

  await Promise.all(
    eligibleSubscribers.map((subscriber) =>
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
    updatedCount: eligibleSubscribers.length,
    skippedCount: subscriberIds.length - eligibleSubscribers.length,
  });
};

const bulkReactivateSubscribers = async (req, res) => {
  const subscriberIds = req.body.subscriberIds || [];

  if (!subscriberIds.length) {
    return res.status(400).json({ message: "Subscriber ids are required" });
  }

  const subscribers = await Subscriber.find({ _id: { $in: subscriberIds } });
  const eligibleSubscribers = subscribers.filter(
    (subscriber) => !(subscriber.status === "blocked" && subscriber.blockedReason === "spam"),
  );
  const emails = eligibleSubscribers.map((subscriber) => subscriber.email);

  await Subscriber.updateMany(
    { _id: { $in: eligibleSubscribers.map((subscriber) => subscriber._id) } },
    { status: "subscribed", blockedReason: "", blockedAt: null },
  );

  if (emails.length) {
    await SuppressionEntry.deleteMany({ email: { $in: emails } });
  }

  return res.json({
    message: "Subscribers reactivated",
    updatedCount: eligibleSubscribers.length,
    skippedCount: subscriberIds.length - eligibleSubscribers.length,
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
      sourceLocation: row.sourceLocation || "admin",
      tags: row.tags || "",
    });

    if (!payload.email) {
      continue;
    }

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
