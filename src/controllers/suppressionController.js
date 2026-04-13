import Subscriber from "../models/Subscriber.js";
import SuppressionEntry from "../models/SuppressionEntry.js";
import { buildDateRangeMatch } from "../utils/dateRange.js";

const normalizeEmail = (email = "") => email.trim().toLowerCase();

const listSuppressions = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const search = req.query.search?.trim();

  const match = {
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

  const subscriber = await Subscriber.findOneAndUpdate(
    { email },
    { status: "suppressed" },
    { returnDocument: "after" }
  );

  const suppression = await SuppressionEntry.findOneAndUpdate(
    { email },
    {
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
  const suppression = await SuppressionEntry.findById(req.params.id);

  if (!suppression) {
    return res.status(404).json({ message: "Suppression entry not found" });
  }

  suppression.status = "released";
  await suppression.save();

  await Subscriber.findOneAndUpdate(
    { email: suppression.email },
    { status: "subscribed" },
    { returnDocument: "after" }
  );

  return res.json({ message: "Suppression released", suppression });
};

const unsubscribeSubscriber = async (req, res) => {
  const subscriber = await Subscriber.findByIdAndUpdate(
    req.params.id,
    { status: "unsubscribed" },
    { returnDocument: "after" }
  );

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  const suppression = await SuppressionEntry.findOneAndUpdate(
    { email: subscriber.email },
    {
      email: subscriber.email,
      reason: "unsubscribe",
      source: "admin",
      status: "active",
      relatedSubscriberId: subscriber._id,
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );

  return res.json({ message: "Subscriber unsubscribed", subscriber, suppression });
};

const suppressSubscriber = async (req, res) => {
  const subscriber = await Subscriber.findById(req.params.id);

  if (!subscriber) {
    return res.status(404).json({ message: "Subscriber not found" });
  }

  const suppression = await SuppressionEntry.findOneAndUpdate(
    { email: subscriber.email },
    {
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
  await subscriber.save();

  return res.json({ message: "Subscriber suppressed", subscriber, suppression });
};

export {
  createSuppression,
  listSuppressions,
  suppressSubscriber,
  unsubscribeSubscriber,
  unsuppressEntry,
};
