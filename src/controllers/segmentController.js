import Segment from "../models/Segment.js";
import Subscriber from "../models/Subscriber.js";
import { buildSubscriberMatch } from "../utils/subscriberFilters.js";

const normalizeRule = (rule) => ({
  field: rule.field?.trim(),
  operator: rule.operator?.trim(),
  value: rule.value,
});

const getPreviewCount = async (rules = []) => {
  const match = buildSubscriberMatch({ rules });
  return Subscriber.countDocuments(match);
};

const getSegmentMeta = async (_req, res) =>
  res.json({
    suggestedRules: [
      {
        field: "purchasedInLastDays",
        operator: "gte",
        label: "Purchased in last X days",
      },
      {
        field: "cartAbandoners",
        operator: "eq",
        label: "Cart abandoners placeholder",
      },
      { field: "inactiveUsers", operator: "gte", label: "Inactive users" },
      { field: "firstTimeBuyers", operator: "eq", label: "First-time buyers" },
      { field: "repeatBuyers", operator: "gte", label: "Repeat buyers" },
      {
        field: "highValueCustomers",
        operator: "gte",
        label: "High value customers",
      },
      {
        field: "openedButDidNotClick",
        operator: "eq",
        label: "Opened but did not click",
      },
      {
        field: "clickedButDidNotPurchase",
        operator: "eq",
        label: "Clicked but did not purchase placeholder",
      },
    ],
  });

const listSegments = async (_req, res) => {
  const segments = await Segment.find().sort({ createdAt: -1 }).lean();
  const items = await Promise.all(
    segments.map(async (segment) => ({
      ...segment,
      previewCount: await getPreviewCount(segment.rules),
    })),
  );

  return res.json(items);
};

const getSegmentById = async (req, res) => {
  const segment = await Segment.findById(req.params.id).lean();

  if (!segment) {
    return res.status(404).json({ message: "Segment not found" });
  }

  return res.json({
    ...segment,
    previewCount: await getPreviewCount(segment.rules),
  });
};

const createSegment = async (req, res) => {
  try {
    const segment = await Segment.create({
      name: req.body.name?.trim(),
      description: req.body.description?.trim() || "",
      rules: (req.body.rules || []).map(normalizeRule),
    });

    return res.status(201).json({
      ...segment.toObject(),
      previewCount: await getPreviewCount(segment.rules),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Segment name already exists" });
    }

    return res.status(400).json({ message: "Unable to create segment" });
  }
};

const updateSegment = async (req, res) => {
  try {
    const segment = await Segment.findByIdAndUpdate(
      req.params.id,
      {
        name: req.body.name?.trim(),
        description: req.body.description?.trim() || "",
        rules: (req.body.rules || []).map(normalizeRule),
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    );

    if (!segment) {
      return res.status(404).json({ message: "Segment not found" });
    }

    return res.json({
      ...segment.toObject(),
      previewCount: await getPreviewCount(segment.rules),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Segment name already exists" });
    }

    return res.status(400).json({ message: "Unable to update segment" });
  }
};

const deleteSegment = async (req, res) => {
  const segment = await Segment.findByIdAndDelete(req.params.id);

  if (!segment) {
    return res.status(404).json({ message: "Segment not found" });
  }

  return res.json({ message: "Segment deleted" });
};

const previewSegment = async (req, res) => {
  try {
    const rules = (req.body.rules || []).map(normalizeRule);
    const match = buildSubscriberMatch({ rules });

    const [previewCount, sampleSubscribers] = await Promise.all([
      Subscriber.countDocuments(match),
      Subscriber.find(match)
        .sort({ engagementScore: -1, updatedAt: -1 })
        .limit(5)
        .select(
          "firstName lastName email status source engagementScore totalOrders totalSpent",
        )
        .lean(),
    ]);

    return res.json({ previewCount, sampleSubscribers });
  } catch (_error) {
    return res.json({ previewCount: 0, sampleSubscribers: [] });
  }
};

export {
  createSegment,
  deleteSegment,
  getSegmentById,
  getSegmentMeta,
  listSegments,
  previewSegment,
  updateSegment,
};
