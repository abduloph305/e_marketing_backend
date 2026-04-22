import Segment from "../models/Segment.js";
import Subscriber from "../models/Subscriber.js";
import {
  buildSegmentQuery,
  normalizeSegmentDefinition,
  summarizeFilter,
} from "../utils/segmentEngine.js";

const segmentCategories = [
  {
    id: "activity",
    label: "User activity",
    description: "Recent email engagement and subscriber activity.",
    fields: [
      { value: "status", label: "Status", kind: "text", operators: ["is", "is_not"] },
      { value: "lastOpenAt", label: "Opened email", kind: "date", operators: ["in_last_days", "before_days"] },
      { value: "lastClickAt", label: "Clicked email", kind: "date", operators: ["in_last_days", "before_days"] },
      { value: "lastActivityAt", label: "Last activity", kind: "date", operators: ["in_last_days", "before_days"] },
      { value: "engagementScore", label: "Engagement score", kind: "number", operators: ["more_than", "less_than", "is", "is_not"] },
    ],
  },
  {
    id: "purchase",
    label: "Purchase",
    description: "Order volume, spend, and cart intent.",
    fields: [
      { value: "totalOrders", label: "Total orders", kind: "number", operators: ["more_than", "less_than", "is", "is_not"] },
      { value: "totalSpent", label: "Total spent", kind: "number", operators: ["more_than", "less_than", "is", "is_not"] },
      { value: "lastOrderDate", label: "Last purchase date", kind: "date", operators: ["in_last_days", "before_days"] },
      { value: "cartAbandoner", label: "Cart abandoner", kind: "boolean", operators: ["is", "is_not"] },
    ],
  },
  {
    id: "location",
    label: "Location",
    description: "Country, state, and city filters.",
    fields: [
      { value: "country", label: "Country", kind: "text", operators: ["is", "is_not"] },
      { value: "state", label: "State", kind: "text", operators: ["is", "is_not"] },
      { value: "city", label: "City", kind: "text", operators: ["is", "is_not"] },
    ],
  },
  {
    id: "tags",
    label: "Tags",
    description: "Simple labels and audience tags.",
    fields: [
      { value: "tags", label: "Has tag", kind: "text", operators: ["is", "is_not", "all"] },
    ],
  },
];

const quickSegments = [
  {
    id: "activeUsers",
    name: "Active Users",
    description: "People who opened or clicked recently.",
    definition: {
      logic: "and",
      filters: [
        { category: "activity", field: "lastActivityAt", operator: "in_last_days", value: "7" },
      ],
    },
  },
  {
    id: "inactiveUsers",
    name: "Inactive Users",
    description: "Contacts who have been quiet for a while.",
    definition: {
      logic: "and",
      filters: [
        { category: "activity", field: "lastActivityAt", operator: "before_days", value: "30" },
      ],
    },
  },
  {
    id: "buyers",
    name: "Buyers",
    description: "Contacts with at least one completed order.",
    definition: {
      logic: "and",
      filters: [
        { category: "purchase", field: "totalOrders", operator: "more_than", value: "0" },
      ],
    },
  },
  {
    id: "highSpenders",
    name: "High Spenders",
    description: "Contacts who spend more than your chosen threshold.",
    definition: {
      logic: "and",
      filters: [
        { category: "purchase", field: "totalSpent", operator: "more_than", value: "500" },
      ],
    },
  },
  {
    id: "cartAbandoners",
    name: "Cart Abandoners",
    description: "Contacts marked as abandoned cart shoppers.",
    definition: {
      logic: "and",
      filters: [
        { category: "purchase", field: "cartAbandoner", operator: "is", value: "true" },
      ],
    },
  },
];

const serializeSegment = (segment, previewCount = 0) => {
  const definition = normalizeSegmentDefinition(segment.definition || { rules: segment.rules || [] });

  return {
    ...segment,
    definition,
    rules: definition.filters,
    previewCount,
    filterSummary: definition.filters.map((filter) => summarizeFilter(filter)),
  };
};

const getPreviewData = async (definition = {}) => {
  if (!normalizeSegmentDefinition(definition).filters.length) {
    return [];
  }

  const match = buildSegmentQuery(definition);
  return Subscriber.find(match)
    .sort({ engagementScore: -1, updatedAt: -1 })
    .limit(5)
    .select(
      "firstName lastName email status country city state tags engagementScore totalOrders totalSpent lastOpenAt lastClickAt lastActivityAt lastOrderDate",
    )
    .lean();
};

const getPreviewCount = async (definition = {}) => {
  if (!normalizeSegmentDefinition(definition).filters.length) {
    return 0;
  }

  const match = buildSegmentQuery(definition);
  return Subscriber.countDocuments(match);
};

const getSegmentMeta = async (_req, res) =>
  res.json({
    categories: segmentCategories,
    quickSegments: quickSegments.map((segment) => ({
      id: segment.id,
      name: segment.name,
      description: segment.description,
      definition: segment.definition,
    })),
    matchModes: [
      { value: "and", label: "Match all conditions" },
      { value: "or", label: "Match any condition" },
    ],
  });

const listSegments = async (_req, res) => {
  const segments = await Segment.find().sort({ createdAt: -1 }).lean();
  const items = await Promise.all(
    segments.map(async (segment) => {
      const definition = normalizeSegmentDefinition(segment.definition || { rules: segment.rules || [] });
      const previewCount = await getPreviewCount(definition);
      return serializeSegment({ ...segment, definition }, previewCount);
    }),
  );

  return res.json(items);
};

const getSegmentById = async (req, res) => {
  const segment = await Segment.findById(req.params.id).lean();

  if (!segment) {
    return res.status(404).json({ message: "Segment not found" });
  }

  const definition = normalizeSegmentDefinition(segment.definition || { rules: segment.rules || [] });

  return res.json({
    ...serializeSegment({ ...segment, definition }, await getPreviewCount(definition)),
  });
};

const createSegment = async (req, res) => {
  try {
    const name = req.body.name?.trim();

    if (!name) {
      return res.status(400).json({ message: "Segment name is required" });
    }

    const definition = normalizeSegmentDefinition(
      req.body.definition || {
        logic: req.body.logic,
        filters: req.body.filters || req.body.rules || [],
      },
    );

    if (!definition.filters.length) {
      return res.status(400).json({ message: "Add at least one condition" });
    }

    const segment = await Segment.create({
      name,
      description: req.body.description?.trim() || "",
      definition,
      rules: definition.filters,
    });

    return res.status(201).json(
      serializeSegment(
        segment.toObject(),
        await getPreviewCount(definition),
      ),
    );
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Segment name already exists" });
    }

    return res.status(400).json({ message: "Unable to create segment" });
  }
};

const updateSegment = async (req, res) => {
  try {
    const name = req.body.name?.trim();

    if (!name) {
      return res.status(400).json({ message: "Segment name is required" });
    }

    const definition = normalizeSegmentDefinition(
      req.body.definition || {
        logic: req.body.logic,
        filters: req.body.filters || req.body.rules || [],
      },
    );

    if (!definition.filters.length) {
      return res.status(400).json({ message: "Add at least one condition" });
    }

    const segment = await Segment.findByIdAndUpdate(
      req.params.id,
      {
        name,
        description: req.body.description?.trim() || "",
        definition,
        rules: definition.filters,
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    ).lean();

    if (!segment) {
      return res.status(404).json({ message: "Segment not found" });
    }

    return res.json(
      serializeSegment(segment, await getPreviewCount(definition)),
    );
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
    const definition = normalizeSegmentDefinition(
      req.body.definition || {
        logic: req.body.logic,
        filters: req.body.filters || req.body.rules || [],
      },
    );

    const [previewCount, sampleSubscribers] = await Promise.all([
      getPreviewCount(definition),
      getPreviewData(definition),
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
