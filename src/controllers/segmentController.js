import Segment from "../models/Segment.js";
import Subscriber from "../models/Subscriber.js";
import {
  buildSegmentQuery,
  normalizeSegmentDefinition,
  summarizeFilter,
} from "../utils/segmentEngine.js";
import {
  buildWebsiteScopeMatch,
  combineAudienceMatches,
  normalizeWebsiteScope,
} from "../utils/audienceWebsiteScope.js";
import { notifyVendorActivity } from "../services/adminNotificationService.js";
import { assertFeatureLimit } from "../services/billingService.js";
import { buildVendorMatch, getRequestVendorId, withVendorWrite } from "../utils/vendorScope.js";

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
  const websiteScope = normalizeWebsiteScope(segment.websiteScope || {});

  return {
    ...segment,
    definition,
    rules: definition.filters,
    websiteScope,
    previewCount,
    filterSummary: definition.filters.map((filter) => summarizeFilter(filter)),
  };
};

const getPreviewData = async (definition = {}, scopeMatch = {}, websiteScope = {}) => {
  if (!normalizeSegmentDefinition(definition).filters.length) {
    return [];
  }

  const match = combineAudienceMatches(scopeMatch, buildWebsiteScopeMatch(websiteScope), buildSegmentQuery(definition));
  return Subscriber.find(match)
    .sort({ engagementScore: -1, updatedAt: -1 })
    .limit(5)
    .select(
      "firstName lastName email status country city state tags engagementScore totalOrders totalSpent lastOpenAt lastClickAt lastActivityAt lastOrderDate",
    )
    .lean();
};

const getPreviewCount = async (definition = {}, scopeMatch = {}, websiteScope = {}) => {
  if (!normalizeSegmentDefinition(definition).filters.length) {
    return 0;
  }

  const match = combineAudienceMatches(scopeMatch, buildWebsiteScopeMatch(websiteScope), buildSegmentQuery(definition));
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

const listSegments = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const segments = await Segment.find(vendorMatch).sort({ createdAt: -1 }).lean();
  const items = await Promise.all(
    segments.map(async (segment) => {
      const definition = normalizeSegmentDefinition(segment.definition || { rules: segment.rules || [] });
      const previewCount = await getPreviewCount(definition, vendorMatch, segment.websiteScope);
      return serializeSegment({ ...segment, definition }, previewCount);
    }),
  );

  return res.json(items);
};

const getSegmentById = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const segment = await Segment.findOne({ _id: req.params.id, ...vendorMatch }).lean();

  if (!segment) {
    return res.status(404).json({ message: "Segment not found" });
  }

  const definition = normalizeSegmentDefinition(segment.definition || { rules: segment.rules || [] });

  return res.json({
    ...serializeSegment(
      { ...segment, definition },
      await getPreviewCount(definition, vendorMatch, segment.websiteScope),
    ),
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

    await assertFeatureLimit(getRequestVendorId(req), "segments");
    const vendorMatch = buildVendorMatch(req);
    const websiteScope = normalizeWebsiteScope(req.body.websiteScope || {});
    const segment = await Segment.create(withVendorWrite(req, {
      name,
      description: req.body.description?.trim() || "",
      definition,
      rules: definition.filters,
      websiteScope,
    }));
    await notifyVendorActivity({
      actor: req.admin,
      entityType: "segment",
      entityId: segment._id,
      action: "created",
      title: "Segment created",
      itemName: segment.name,
    });

    return res.status(201).json(
      serializeSegment(
        segment.toObject(),
        await getPreviewCount(definition, vendorMatch, websiteScope),
      ),
    );
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Segment name already exists" });
    }

    return res.status(error.status || 400).json({ message: error.message || "Unable to create segment" });
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

    const vendorMatch = buildVendorMatch(req);
    const websiteScope = normalizeWebsiteScope(req.body.websiteScope || {});
    const segment = await Segment.findOneAndUpdate(
      { _id: req.params.id, ...vendorMatch },
      {
        name,
        description: req.body.description?.trim() || "",
        definition,
        rules: definition.filters,
        websiteScope,
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    ).lean();

    if (!segment) {
      return res.status(404).json({ message: "Segment not found" });
    }

    await notifyVendorActivity({
      actor: req.admin,
      entityType: "segment",
      entityId: segment._id,
      action: "updated",
      title: "Segment updated",
      itemName: segment.name,
    });

    return res.json(
      serializeSegment(segment, await getPreviewCount(definition, vendorMatch, websiteScope)),
    );
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Segment name already exists" });
    }

    return res.status(400).json({ message: "Unable to update segment" });
  }
};

const deleteSegment = async (req, res) => {
  const segment = await Segment.findOneAndDelete({ _id: req.params.id, ...buildVendorMatch(req) });

  if (!segment) {
    return res.status(404).json({ message: "Segment not found" });
  }

  await notifyVendorActivity({
    actor: req.admin,
    entityType: "segment",
    entityId: segment._id,
    action: "deleted",
    title: "Segment deleted",
    itemName: segment.name,
  });

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

    const vendorMatch = buildVendorMatch(req);
    const websiteScope = normalizeWebsiteScope(req.body.websiteScope || {});
    const [previewCount, sampleSubscribers] = await Promise.all([
      getPreviewCount(definition, vendorMatch, websiteScope),
      getPreviewData(definition, vendorMatch, websiteScope),
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
