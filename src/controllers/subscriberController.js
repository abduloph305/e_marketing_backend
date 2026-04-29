import mongoose from "mongoose";
import CampaignRecipient from "../models/CampaignRecipient.js";
import EmailEvent from "../models/EmailEvent.js";
import Subscriber, {
  subscriberSources,
  subscriberStatuses,
} from "../models/Subscriber.js";
import SellersLoginWebsite from "../models/SellersLoginWebsite.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { env } from "../config/env.js";
import { triggerWorkflowExecutions } from "../services/automationService.js";
import { syncVendorCustomersFromSellersLogin } from "../services/sellersloginAudienceSyncService.js";
import { inferDeviceType } from "../utils/device.js";
import { buildSubscriberMatch } from "../utils/subscriberFilters.js";
import { buildVendorMatch, getRequestVendorId, withVendorScope, withVendorWrite } from "../utils/vendorScope.js";

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

const normalizeId = (value = "") => String(value || "").trim();

const buildApiUrl = (baseUrl = "", path = "") => {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const suffix = String(path || "").trim().replace(/^\/+/, "");
  return base && suffix ? `${base}/${suffix}` : "";
};

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

const getInternalSecret = () =>
  normalizeId(
    env.ophmateWebhookSecret ||
      process.env.MARKETING_WEBHOOK_SECRET ||
      process.env.MARKETING_INTERNAL_SECRET,
  );

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

const normalizeEventDevice = (event = null) => {
  if (!event) {
    return null;
  }

  const deviceType = event.deviceType || inferDeviceType(event.userAgent);

  return {
    deviceType,
    userAgent: event.userAgent || "",
    timestamp: event.timestamp || null,
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

  const vendorMatch = subscriber.vendorId ? { vendorId: subscriber.vendorId } : {};
  const [recentEmailEvents, latestOpenEvent, latestClickEvent, campaignHistory, suppressionEntry] =
    await Promise.all([
      EmailEvent.find({ ...vendorMatch, recipientEmail: subscriber.email })
        .sort({ timestamp: -1 })
        .limit(12)
        .select(
          "eventType timestamp clickedLink bounceType complaintFeedbackType deviceType userAgent",
        )
        .lean(),
      EmailEvent.findOne({
        ...vendorMatch,
        recipientEmail: subscriber.email,
        eventType: "open",
      })
        .sort({ timestamp: -1 })
        .select("timestamp deviceType userAgent")
        .lean(),
      EmailEvent.findOne({
        ...vendorMatch,
        recipientEmail: subscriber.email,
        eventType: "click",
      })
        .sort({ timestamp: -1 })
        .select("timestamp deviceType userAgent")
        .lean(),
      CampaignRecipient.find({ ...vendorMatch, email: subscriber.email })
        .sort({ updatedAt: -1 })
        .limit(12)
        .populate({ path: "campaignId", select: "name status subject" })
        .lean(),
      SuppressionEntry.findOne({ ...vendorMatch, email: subscriber.email }).lean(),
    ]);

  return {
    ...subscriber.toObject(),
    sourceLocation: resolveSourceLocation(subscriber.toObject()),
    campaignHistory,
    recentEmailEvents: recentEmailEvents.map((event) => ({
      ...event,
      deviceType: event.deviceType || inferDeviceType(event.userAgent),
    })),
    engagementDevices: {
      lastOpen: normalizeEventDevice(latestOpenEvent),
      lastClick: normalizeEventDevice(latestClickEvent),
    },
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
    const normalizedComplaints = await Subscriber.updateMany(
      { status: "complained" },
      {
        status: "blocked",
        blockedReason: "spam",
        blockedAt: new Date(),
      },
    );

    console.log("[audience] refresh completed", {
      complaintToBlockedCount: normalizedComplaints.modifiedCount || 0,
    });
  } catch (error) {
    console.warn("Audience sync skipped", error?.message || error);
  }
};

const getWebsiteDisplayName = (website = {}) =>
  String(
    website.name ||
      website.business_name ||
      website.website_slug ||
      website.template_name ||
      website.template_key ||
      "Website",
  ).trim();

const normalizeWebsiteOption = (item = {}) => {
  const websiteId = String(item.websiteId || item._id?.websiteId || "").trim();
  const websiteSlug = String(item.websiteSlug || item._id?.websiteSlug || "").trim();
  const websiteName = String(item.websiteName || item._id?.websiteName || "").trim();
  const label = websiteName || websiteSlug || websiteId || "Website";

  return {
    id: [websiteId, websiteSlug, websiteName].join("::"),
    websiteId,
    websiteSlug,
    websiteName,
    label,
    count: item.count || 0,
  };
};

const mergeWebsiteOptions = (websites = [], counts = []) => {
  const countByIdentity = new Map();

  counts.forEach((item) => {
    [item.websiteId, item.websiteSlug, item.websiteName]
      .map(normalizeId)
      .filter(Boolean)
      .forEach((key) => countByIdentity.set(key, item.count || 0));
  });

  const merged = new Map();
  const addOption = (option = {}) => {
    const normalized = normalizeWebsiteOption(option);
    if (!normalized.id) {
      return;
    }

    const count =
      countByIdentity.get(normalized.websiteId) ||
      countByIdentity.get(normalized.websiteSlug) ||
      countByIdentity.get(normalized.websiteName) ||
      normalized.count ||
      0;

    merged.set(normalized.id, {
      ...normalized,
      count,
    });
  };

  websites.forEach((website) => {
    addOption({
      websiteId: normalizeId(website._id || website.id),
      websiteSlug: normalizeId(website.website_slug),
      websiteName: getWebsiteDisplayName(website),
      count: 0,
    });
  });
  counts.forEach(addOption);

  return Array.from(merged.values()).sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }

    return left.label.localeCompare(right.label);
  });
};

const fetchSellersLoginVendorWebsites = async (vendorId = "") => {
  const url = buildApiUrl(env.sellersloginApiUrl, "internal/marketing/vendor-websites");
  const secret = getInternalSecret();

  if (!url || !secret || !vendorId) {
    return [];
  }

  const query = new URLSearchParams({ vendor_id: vendorId });
  const { response, data } = await fetchJson(`${url}?${query.toString()}`, {
    headers: {
      "x-integration-secret": secret,
    },
  });

  if (!response.ok) {
    throw new Error(data?.message || "Unable to load SellersLogin websites");
  }

  return Array.isArray(data?.websites) ? data.websites : [];
};

const getSubscriberWebsiteOptions = async (req = {}) => {
  const vendorMatch = buildVendorMatch(req);
  const vendorId = normalizeId(vendorMatch.vendorId);
  const allowedWebsiteIds = Array.isArray(req.admin?.sellersloginWebsiteAccess)
    ? req.admin.sellersloginWebsiteAccess.map(normalizeId).filter(Boolean)
    : [];
  const websiteQuery = {};

  if (vendorId) {
    websiteQuery.vendor_id = mongoose.Types.ObjectId.isValid(vendorId)
      ? { $in: [vendorId, new mongoose.Types.ObjectId(vendorId)] }
      : vendorId;
  }

  if (allowedWebsiteIds.length) {
    websiteQuery._id = {
      $in: allowedWebsiteIds
        .filter((item) => mongoose.Types.ObjectId.isValid(item))
        .map((item) => new mongoose.Types.ObjectId(item)),
    };
  }

  const [sourceWebsitesResult, rows] = await Promise.allSettled([
    fetchSellersLoginVendorWebsites(vendorId),
    Subscriber.aggregate([
      { $match: vendorMatch },
      {
        $project: {
          websiteId: { $ifNull: ["$customFields.audienceSourceWebsiteId", ""] },
          websiteSlug: { $ifNull: ["$customFields.audienceSourceWebsiteSlug", ""] },
          websiteName: { $ifNull: ["$customFields.audienceSourceWebsiteName", ""] },
        },
      },
      {
        $match: {
          $or: [
            { websiteId: { $nin: ["", null] } },
            { websiteSlug: { $nin: ["", null] } },
            { websiteName: { $nin: ["", null] } },
          ],
        },
      },
      {
        $group: {
          _id: {
            websiteId: "$websiteId",
            websiteSlug: "$websiteSlug",
            websiteName: "$websiteName",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.websiteName": 1, "_id.websiteSlug": 1, "_id.websiteId": 1 } },
    ]),
  ]);
  const sourceWebsites =
    sourceWebsitesResult.status === "fulfilled"
      ? sourceWebsitesResult.value.filter(
          (website) =>
            !allowedWebsiteIds.length ||
            allowedWebsiteIds.includes(normalizeId(website.website_id || website.id)),
        )
      : [];
  const countRows = rows.status === "fulfilled" ? rows.value.map(normalizeWebsiteOption) : [];
  const localWebsites = sourceWebsites.length
    ? []
    : await SellersLoginWebsite.find(websiteQuery)
        .select("_id vendor_id template_key template_name name business_name website_slug is_default createdAt")
        .sort({ is_default: -1, createdAt: -1 })
        .lean();
  const websites = sourceWebsites.length
    ? sourceWebsites.map((website) => ({
        _id: website.website_id || website.id,
        name: website.website_name,
        website_slug: website.website_slug,
        template_name: website.template_name,
        template_key: website.template_key,
        is_default: website.is_default,
        createdAt: website.createdAt,
      }))
    : localWebsites;

  return mergeWebsiteOptions(websites, countRows);
};

const getSubscriberMeta = async (req, res) => {
  const websites = await getSubscriberWebsiteOptions(req);

  return res.json({
    statuses: subscriberStatuses,
    sources: subscriberSources,
    websites,
  });
};

const getSubscriberSummary = async (req, res) => {
  try {
    await runBestEffortCleanup();
    const vendorMatch = buildVendorMatch(req);
    const scopedMatch = withVendorScope(req, buildSubscriberMatch(req.query));

    const [statusCounts, totals, sourceDocs, websites] = await Promise.all([
      Subscriber.aggregate([
        { $match: scopedMatch },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Subscriber.aggregate([
        { $match: scopedMatch },
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
      Subscriber.find(scopedMatch)
        .select("source sourceLocation customFields")
        .lean(),
      getSubscriberWebsiteOptions(req),
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
      websites,
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
      websites: [],
    });
  }
};

const syncMyVendorAudience = async (req, res) => {
  const vendorId = getRequestVendorId(req);
  if (!vendorId) {
    return res.status(400).json({ message: "Vendor account required" });
  }

  try {
    const websiteId = String(req.body?.websiteId || req.query?.websiteId || "").trim();
    const result = await syncVendorCustomersFromSellersLogin({ vendorId, websiteId });
    return res.json({
      message: result.skipped ? "Audience sync skipped" : "Audience synced",
      result,
    });
  } catch (error) {
    return res.status(502).json({
      message: error?.message || "Unable to sync SellersLogin customers",
    });
  }
};

const listSubscribers = async (req, res) => {
  await runBestEffortCleanup();

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const match = withVendorScope(req, buildSubscriberMatch(req.query));

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
  const match = withVendorScope(req, buildSubscriberMatch(req.body));

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
  const subscriber = await Subscriber.findOne({ _id: req.params.id, ...buildVendorMatch(req) });

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  return res.json(await buildDetailPayload(subscriber));
};

const createSubscriber = async (req, res) => {
  try {
    const subscriber = await Subscriber.create(
      withVendorWrite(req, normalizeSubscriberPayload(req.body)),
    );

    triggerWorkflowExecutions({
      trigger: "welcome_signup",
      subscriberId: subscriber._id,
      context: {
        source: "subscriber.created",
        vendorId: subscriber.vendorId || "",
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
    const vendorMatch = buildVendorMatch(req);
    const existingSubscriber = await Subscriber.findOne({ _id: req.params.id, ...vendorMatch }).lean();

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

    const subscriber = await Subscriber.findOneAndUpdate(
      { _id: req.params.id, ...vendorMatch },
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
  const subscriber = await Subscriber.findOneAndDelete({ _id: req.params.id, ...buildVendorMatch(req) });

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
    { _id: { $in: subscriberIds }, ...buildVendorMatch(req) },
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

  const vendorMatch = buildVendorMatch(req);
  const subscribers = await Subscriber.find({ _id: { $in: subscriberIds }, ...vendorMatch });
  const eligibleSubscribers = subscribers.filter(
    (subscriber) => !(subscriber.status === "blocked" && subscriber.blockedReason === "spam"),
  );

  await Subscriber.updateMany(
    { _id: { $in: eligibleSubscribers.map((subscriber) => subscriber._id) }, ...vendorMatch },
    { status: "unsubscribed", blockedReason: "", blockedAt: null },
  );

  await Promise.all(
    eligibleSubscribers.map((subscriber) =>
      SuppressionEntry.findOneAndUpdate(
        { ...vendorMatch, email: subscriber.email },
        {
          ...vendorMatch,
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

  const vendorMatch = buildVendorMatch(req);
  const subscribers = await Subscriber.find({ _id: { $in: subscriberIds }, ...vendorMatch });
  const eligibleSubscribers = subscribers.filter(
    (subscriber) => !(subscriber.status === "blocked" && subscriber.blockedReason === "spam"),
  );

  await Subscriber.updateMany(
    { _id: { $in: eligibleSubscribers.map((subscriber) => subscriber._id) }, ...vendorMatch },
    { status: "suppressed", blockedReason: "", blockedAt: null },
  );

  await Promise.all(
    eligibleSubscribers.map((subscriber) =>
      SuppressionEntry.findOneAndUpdate(
        { ...vendorMatch, email: subscriber.email },
        {
          ...vendorMatch,
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

  const vendorMatch = buildVendorMatch(req);
  const subscribers = await Subscriber.find({ _id: { $in: subscriberIds }, ...vendorMatch });
  const eligibleSubscribers = subscribers.filter(
    (subscriber) => !(subscriber.status === "blocked" && subscriber.blockedReason === "spam"),
  );
  const emails = eligibleSubscribers.map((subscriber) => subscriber.email);

  await Subscriber.updateMany(
    { _id: { $in: eligibleSubscribers.map((subscriber) => subscriber._id) }, ...vendorMatch },
    { status: "subscribed", blockedReason: "", blockedAt: null },
  );

  if (emails.length) {
    await SuppressionEntry.deleteMany({ ...vendorMatch, email: { $in: emails } });
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
  const vendorMatch = buildVendorMatch(req);

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

    const scopedPayload = withVendorWrite(req, payload);
    const existing = await Subscriber.findOne({ ...vendorMatch, email: payload.email });

    if (existing) {
      await Subscriber.findByIdAndUpdate(existing._id, scopedPayload, {
        returnDocument: "after",
        runValidators: true,
      });
      updatedCount += 1;
    } else {
      await Subscriber.create(scopedPayload);
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
  syncMyVendorAudience,
  updateSubscriber,
};
