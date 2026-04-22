const textFields = new Set([
  "status",
  "source",
  "sourceLocation",
  "country",
  "state",
  "city",
  "tags",
]);
const numberFields = new Set(["totalOrders", "totalSpent", "engagementScore"]);
const dateFields = new Set([
  "lastOpenAt",
  "lastClickAt",
  "lastActivityAt",
  "lastOrderDate",
]);

const legacyConditionMap = {
  purchasedInLastDays: ({ value }) => ({
    field: "lastOrderDate",
    operator: "in_last_days",
    value,
  }),
  inactiveUsers: ({ value }) => ({
    field: "lastActivityAt",
    operator: "before_days",
    value,
  }),
  firstTimeBuyers: () => ({
    field: "totalOrders",
    operator: "is",
    value: "1",
  }),
  repeatBuyers: ({ value }) => ({
    field: "totalOrders",
    operator: "more_than",
    value: value ?? "1",
  }),
  highValueCustomers: ({ value }) => ({
    field: "totalSpent",
    operator: "more_than",
    value: value ?? "500",
  }),
  openedButDidNotClick: () => ({
    field: "lastOpenAt",
    operator: "is_set",
    value: "true",
  }),
  clickedButDidNotPurchase: () => ({
    field: "lastClickAt",
    operator: "is_set",
    value: "true",
  }),
  cartAbandoners: () => ({
    field: "cartAbandoner",
    operator: "is",
    value: "true",
  }),
};

const normalizeValue = (value) => {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
};

const normalizeFilters = (filters = []) =>
  filters
    .map((filter) => {
      if (!filter) {
        return null;
      }

      if (filter.field && !filter.category) {
        return {
          category: filter.category || "custom",
          field: normalizeValue(filter.field),
          operator: normalizeValue(filter.operator) || "is",
          value: filter.value ?? "",
        };
      }

      return {
        category: normalizeValue(filter.category) || "custom",
        field: normalizeValue(filter.field),
        operator: normalizeValue(filter.operator) || "is",
        value: filter.value ?? "",
      };
    })
    .filter((filter) => filter && filter.field);

const normalizeSegmentDefinition = (input = {}) => {
  const sourceFilters = Array.isArray(input.filters)
    ? input.filters
    : Array.isArray(input.rules)
      ? input.rules.map((rule) => {
          const legacyMapper = legacyConditionMap[rule.field];

          if (legacyMapper) {
            return {
              category: "legacy",
              ...legacyMapper(rule),
            };
          }

          return {
            category: "legacy",
            field: rule.field,
            operator: rule.operator || "is",
            value: rule.value ?? "",
          };
        })
      : [];

  return {
    logic: input.logic === "or" ? "or" : "and",
    filters: normalizeFilters(sourceFilters),
  };
};

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildDateThreshold = (value, fallback = 0) => {
  const days = Number(value ?? fallback);

  if (!Number.isFinite(days) || days < 0) {
    return null;
  }

  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
};

const buildNumberCondition = (field, operator, value) => {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  if (operator === "is_not") {
    return {
      $or: [{ [field]: { $exists: false } }, { [field]: { $ne: numericValue } }],
    };
  }

  if (operator === "less_than") {
    return { [field]: { $lt: numericValue } };
  }

  if (operator === "more_than") {
    return { [field]: { $gt: numericValue } };
  }

  return { [field]: numericValue };
};

const buildDateCondition = (field, operator, value) => {
  if (operator === "is_set") {
    return { [field]: { $ne: null } };
  }

  const threshold = buildDateThreshold(value, operator === "before_days" ? value : 0);

  if (!threshold) {
    return null;
  }

  if (operator === "before_days") {
    return {
      $or: [{ [field]: { $lt: threshold } }, { [field]: null }],
    };
  }

  if (operator === "less_than") {
    return { [field]: { $lt: threshold } };
  }

  if (operator === "more_than") {
    return { [field]: { $gt: threshold } };
  }

  return { [field]: { $gte: threshold } };
};

const buildTextCondition = (field, operator, value) => {
  const normalizedValue = normalizeValue(value);

  if (!normalizedValue) {
    return null;
  }

  if (field === "tags") {
    const values = String(normalizedValue)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (operator === "is_not") {
      return {
        $nor: [{ tags: { $in: values } }],
      };
    }

    return operator === "all"
      ? { tags: { $all: values } }
      : { tags: { $in: values } };
  }

  const exactPattern = new RegExp(`^${escapeRegex(normalizedValue)}$`, "i");

  if (operator === "is_not") {
    return {
      $or: [{ [field]: { $exists: false } }, { [field]: { $not: exactPattern } }],
    };
  }

  if (operator === "contains") {
    return { [field]: new RegExp(escapeRegex(normalizedValue), "i") };
  }

  return { [field]: exactPattern };
};

const buildSpecialCondition = (field, operator, value) => {
  const normalizedValue = normalizeValue(value).toLowerCase();

  if (field === "cartAbandoner") {
    const isTrue = ["true", "1", "yes", "on"].includes(normalizedValue);

    if (operator === "is_not") {
      return {
        $or: [
          { "customFields.cartAbandoner": { $exists: false } },
          { "customFields.cartAbandoner": { $ne: true } },
        ],
      };
    }

    return { "customFields.cartAbandoner": isTrue };
  }

  return null;
};

const buildCondition = (filter = {}) => {
  const field = normalizeValue(filter.field);
  const operator = normalizeValue(filter.operator) || "is";
  const value = filter.value;

  if (!field) {
    return null;
  }

  if (numberFields.has(field)) {
    return buildNumberCondition(field, operator, value);
  }

  if (dateFields.has(field)) {
    return buildDateCondition(field, operator, value);
  }

  if (textFields.has(field)) {
    return buildTextCondition(field, operator, value);
  }

  return buildSpecialCondition(field, operator, value);
};

const buildSegmentQuery = (definition = {}) => {
  const normalized = normalizeSegmentDefinition(definition);
  const conditions = normalized.filters
    .map((filter) => buildCondition(filter))
    .filter(Boolean);

  if (!conditions.length) {
    return {};
  }

  if (conditions.length === 1) {
    return conditions[0];
  }

  return normalized.logic === "or" ? { $or: conditions } : { $and: conditions };
};

const summarizeFilter = (filter = {}) => {
  const fieldLabelMap = {
    status: "Status",
    source: "Source",
    country: "Country",
    state: "State",
    city: "City",
    tags: "Tags",
    totalOrders: "Total orders",
    totalSpent: "Total spent",
    engagementScore: "Engagement score",
    lastOpenAt: "Last open",
    lastClickAt: "Last click",
    lastActivityAt: "Last activity",
    lastOrderDate: "Last purchase",
    cartAbandoner: "Cart abandoner",
  };

  const operatorLabelMap = {
    is: "is",
    is_not: "is not",
    more_than: "more than",
    less_than: "less than",
    in_last_days: "in last",
    before_days: "inactive for",
    all: "has all",
  };

  const field = normalizeValue(filter.field);
  const operator = normalizeValue(filter.operator) || "is";
  const value = normalizeValue(filter.value);

  if (operator === "in_last_days" || operator === "before_days") {
    return `${fieldLabelMap[field] || field} ${operatorLabelMap[operator]} ${value} days`;
  }

  if (field === "cartAbandoner") {
    return `${fieldLabelMap[field] || field} ${operator === "is_not" ? "is not" : "is"} ${value || "true"}`;
  }

  return `${fieldLabelMap[field] || field} ${operatorLabelMap[operator] || operator} ${value}`;
};

export {
  buildCondition,
  buildSegmentQuery,
  normalizeFilters,
  normalizeSegmentDefinition,
  summarizeFilter,
};
