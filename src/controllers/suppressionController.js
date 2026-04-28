import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { buildDateRangeMatch } from "../utils/dateRange.js";
import { buildVendorMatch } from "../utils/vendorScope.js";

const normalizeEmail = (email = "") => email.trim().toLowerCase();

const isSpamBlocked = (subscriber) =>
  subscriber?.status === "blocked" && subscriber?.blockedReason === "spam";

const listSuppressions = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const search = req.query.search?.trim();

  const match = {
    ...buildVendorMatch(req),
    ...buildDateRangeMatch(req.query.startDate, req.query.endDate),
  };

  if (req.query.status) {
    match.status = req.query.status;
  }

  if (req.query.reason) {
    match.reason = req.query.reason;
  }

  if (search) {
    match.email = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const [items, total, unsubscribeCount] = await Promise.all([
    SuppressionEntry.find(match)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    SuppressionEntry.countDocuments(match),
    SuppressionEntry.countDocuments({
      ...match,
      reason: "unsubscribe",
    }),
  ]);

  return res.json({
    data: items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
    counts: {
      total,
      unsubscribeCount,
    },
  });
};

const createSuppression = async (req, res) => {
  const email = normalizeEmail(req.body.email);

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  const vendorMatch = buildVendorMatch(req);
  const existingSubscriber = await Subscriber.findOne({ ...vendorMatch, email }).select(
    "status blockedReason",
  );

  if (isSpamBlocked(existingSubscriber)) {
    return res
      .status(403)
      .json({ message: "Spam-blocked subscribers cannot be changed manually" });
  }

  const subscriber = await Subscriber.findOneAndUpdate(
    { ...vendorMatch, email },
    { status: "suppressed" },
    { returnDocument: "after" }
  );

  const suppression = await SuppressionEntry.findOneAndUpdate(
    { ...vendorMatch, email },
    {
      ...vendorMatch,
      email,
      reason: req.body.reason || "manual",
      source: req.body.source || "admin",
      status: "active",
      relatedCampaignId: req.body.relatedCampaignId || null,
      relatedSubscriberId: req.body.relatedSubscriberId || subscriber?._id || null,
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  );

  return res.status(201).json(suppression);
};

const unsuppressEntry = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const suppression = await SuppressionEntry.findOne({ _id: req.params.id, ...vendorMatch });

  if (!suppression) {
    return res.status(404).json({ message: "Suppression entry not found" });
  }

  if (suppression.reason === "complaint") {
    return res
      .status(403)
      .json({ message: "Spam complaint entries cannot be released manually" });
  }

  const subscriber = await Subscriber.findOne({ ...vendorMatch, email: suppression.email }).select(
    "status blockedReason",
  );

  if (isSpamBlocked(subscriber)) {
    return res
      .status(403)
      .json({ message: "Spam-blocked subscribers cannot be unblocked manually" });
  }

  suppression.status = "released";
  await suppression.save();

  await Subscriber.findOneAndUpdate(
    { ...vendorMatch, email: suppression.email },
    { status: "subscribed", blockedReason: "", blockedAt: null },
    { returnDocument: "after" }
  );

  return res.json({ message: "Suppression released", suppression });
};

const unsubscribeSubscriber = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const subscriber = await Subscriber.findOne({ _id: req.params.id, ...vendorMatch });

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  if (isSpamBlocked(subscriber)) {
    return res
      .status(403)
      .json({ message: "Spam-blocked subscribers cannot be changed manually" });
  }

  const updatedSubscriber = await Subscriber.findOneAndUpdate(
    { _id: req.params.id, ...vendorMatch },
    { status: "unsubscribed", blockedReason: "", blockedAt: null },
    { returnDocument: "after" }
  );

  const suppression = await SuppressionEntry.findOneAndUpdate(
    { ...vendorMatch, email: subscriber.email },
    {
      ...vendorMatch,
      email: subscriber.email,
      reason: "unsubscribe",
      source: "admin",
      status: "active",
      relatedSubscriberId: subscriber._id,
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );

  return res.json({
    message: "Subscriber unsubscribed",
    subscriber: updatedSubscriber,
    suppression,
  });
};

const suppressSubscriber = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const subscriber = await Subscriber.findOne({ _id: req.params.id, ...vendorMatch });

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  if (isSpamBlocked(subscriber)) {
    return res
      .status(403)
      .json({ message: "Spam-blocked subscribers cannot be changed manually" });
  }

  const suppression = await SuppressionEntry.findOneAndUpdate(
    { ...vendorMatch, email: subscriber.email },
    {
      ...vendorMatch,
      email: subscriber.email,
      reason: req.body.reason || "manual",
      source: "admin",
      status: "active",
      relatedCampaignId: req.body.relatedCampaignId || null,
      relatedSubscriberId: subscriber._id,
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true }
  );

  subscriber.status = "suppressed";
  subscriber.blockedReason = "";
  subscriber.blockedAt = null;
  await subscriber.save();

  return res.json({ message: "Subscriber suppressed", subscriber, suppression });
};

const blockSubscriber = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const subscriber = await Subscriber.findOne({ _id: req.params.id, ...vendorMatch });

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  if (isSpamBlocked(subscriber)) {
    return res
      .status(403)
      .json({ message: "Spam-blocked subscribers cannot be changed manually" });
  }

  const blockedSubscriber = await Subscriber.findOneAndUpdate(
    { _id: req.params.id, ...vendorMatch },
    {
      status: "blocked",
      blockedReason: "manual",
      blockedAt: new Date(),
    },
    { returnDocument: "after", runValidators: true }
  );

  const suppression = await SuppressionEntry.findOneAndUpdate(
    { ...vendorMatch, email: subscriber.email },
    {
      ...vendorMatch,
      email: subscriber.email,
      reason: "manual",
      source: "admin",
      status: "active",
      relatedSubscriberId: subscriber._id,
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, runValidators: true }
  );

  return res.json({ message: "Subscriber blocked", subscriber: blockedSubscriber, suppression });
};

const unblockSubscriber = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const subscriber = await Subscriber.findOne({ _id: req.params.id, ...vendorMatch });

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  if (subscriber.status !== "blocked") {
    return res.status(400).json({ message: "Subscriber is not blocked" });
  }

  if (subscriber.blockedReason === "spam") {
    return res
      .status(403)
      .json({ message: "Spam-blocked subscribers cannot be unblocked manually" });
  }

  const unblockedSubscriber = await Subscriber.findOneAndUpdate(
    { _id: req.params.id, ...vendorMatch },
    {
      status: "subscribed",
      blockedReason: "",
      blockedAt: null,
    },
    { returnDocument: "after", runValidators: true }
  );

  await SuppressionEntry.deleteMany({ ...vendorMatch, email: subscriber.email });

  return res.json({ message: "Subscriber unblocked", subscriber: unblockedSubscriber });
};

export {
  blockSubscriber,
  createSuppression,
  listSuppressions,
  suppressSubscriber,
  unsubscribeSubscriber,
  unsuppressEntry,
  unblockSubscriber,
};
