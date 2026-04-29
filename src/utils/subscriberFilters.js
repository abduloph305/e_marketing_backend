const locationFields = ["country", "state", "city"];
const numberFields = ["totalOrders", "totalSpent", "engagementScore"];
const dateFields = ["lastOpenAt", "lastClickAt", "lastOrderDate", "lastEmailSentAt", "lastActivityAt"];
const websiteFilterFields = [
  ["websiteId", "customFields.audienceSourceWebsiteId"],
  ["websiteSlug", "customFields.audienceSourceWebsiteSlug"],
  ["websiteName", "customFields.audienceSourceWebsiteName"],
];

const normalizeArray = (value) => {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      String(entry)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    );
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildSearchQuery = (search) => {
  if (!search) {
    return null;
  }

  const pattern = new RegExp(escapeRegex(search.trim()), "i");

  return {
    $or: [
      { firstName: pattern },
      { lastName: pattern },
      { email: pattern },
      { city: pattern },
      { state: pattern },
      { country: pattern },
      { source: pattern },
      { sourceLocation: pattern },
      { notes: pattern },
      { tags: pattern },
    ],
  };
};

const buildDaysAgoDate = (value) => {
  const days = Number(value);

  if (Number.isNaN(days)) {
    return null;
  }

  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
};

const buildRuleCondition = ({ field, operator, value }) => {
  if (!field || value === undefined) {
    return null;
  }

  if (field === "status") {
    if (operator === "in") {
      const values = normalizeArray(value);
      return values.length ? { status: { $in: values } } : null;
    }

    return { status: String(value).trim() };
  }

  if (field === "source") {
    const values = normalizeArray(value);
    return values.length === 1 ? { source: values[0] } : { source: { $in: values } };
  }

  if (field === "sourceLocation") {
    const values = normalizeArray(value);
    return values.length === 1
      ? { sourceLocation: values[0] }
      : { sourceLocation: { $in: values } };
  }

  if (field === "tags") {
    const values = normalizeArray(value);

    if (!values.length) {
      return null;
    }

    return operator === "all"
      ? { tags: { $all: values } }
      : { tags: { $in: values } };
  }

  if (locationFields.includes(field)) {
    const values = normalizeArray(value);

    if (!values.length) {
      return null;
    }

    return values.length === 1
      ? { [field]: new RegExp(`^${escapeRegex(values[0])}$`, "i") }
      : {
          $or: values.map((entry) => ({
            [field]: new RegExp(`^${escapeRegex(entry)}$`, "i"),
          })),
        };
  }

  if (numberFields.includes(field)) {
    const numericValue = Number(value);

    if (Number.isNaN(numericValue)) {
      return null;
    }

    const operatorMap = {
      gte: { [field]: { $gte: numericValue } },
      lte: { [field]: { $lte: numericValue } },
      gt: { [field]: { $gt: numericValue } },
      lt: { [field]: { $lt: numericValue } },
      eq: { [field]: numericValue },
    };

    return operatorMap[operator] || operatorMap.gte;
  }

  if (dateFields.includes(field)) {
    if (operator === "exists") {
      return { [field]: { $ne: null } };
    }

    const parsedDate = new Date(value);

    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }

    const operatorMap = {
      after: { [field]: { $gte: parsedDate } },
      before: { [field]: { $lte: parsedDate } },
      onOrAfter: { [field]: { $gte: parsedDate } },
      onOrBefore: { [field]: { $lte: parsedDate } },
    };

    return operatorMap[operator] || operatorMap.after;
  }

  if (field === "purchasedInLastDays") {
    const date = buildDaysAgoDate(value);
    return date ? { lastOrderDate: { $gte: date } } : null;
  }

  if (field === "inactiveUsers") {
    const date = buildDaysAgoDate(value || 30);
    return date
      ? {
          $or: [{ lastActivityAt: { $lt: date } }, { lastActivityAt: null }],
        }
      : null;
  }

  if (field === "firstTimeBuyers") {
    return { totalOrders: 1 };
  }

  if (field === "repeatBuyers") {
    return { totalOrders: { $gte: Number(value || 2) } };
  }

  if (field === "highValueCustomers") {
    return { totalSpent: { $gte: Number(value || 500) } };
  }

  if (field === "openedButDidNotClick") {
    return {
      $and: [{ lastOpenAt: { $ne: null } }, { lastClickAt: null }],
    };
  }

  if (field === "cartAbandoners") {
    return { "customFields.cartAbandoner": true };
  }

  if (field === "clickedButDidNotPurchase") {
    return { "customFields.clickedNoPurchase": true };
  }

  return null;
};

const buildSubscriberMatch = (input = {}) => {
  const conditions = [];
  const {
    search,
    status,
    tags,
    country,
    state,
    city,
    source,
    sourceLocation,
    websiteId,
    websiteSlug,
    websiteName,
    rules = [],
  } = input;

  const searchQuery = buildSearchQuery(search);
  if (searchQuery) {
    conditions.push(searchQuery);
  }

  const statuses = normalizeArray(status);
  if (statuses.length) {
    conditions.push({
      status: statuses.length === 1 ? statuses[0] : { $in: statuses },
    });
  }

  const sources = normalizeArray(source);
  if (sources.length) {
    conditions.push({
      source: sources.length === 1 ? sources[0] : { $in: sources },
    });
  }

  const sourceLocations = normalizeArray(sourceLocation);
  if (sourceLocations.length) {
    conditions.push({
      sourceLocation:
        sourceLocations.length === 1
          ? sourceLocations[0]
          : { $in: sourceLocations },
    });
  }

  websiteFilterFields.forEach(([inputKey, documentPath]) => {
    const values = normalizeArray({ websiteId, websiteSlug, websiteName }[inputKey]);

    if (!values.length) {
      return;
    }

    conditions.push({
      [documentPath]:
        values.length === 1
          ? new RegExp(`^${escapeRegex(values[0])}$`, "i")
          : {
              $in: values.map((value) => new RegExp(`^${escapeRegex(value)}$`, "i")),
            },
    });
  });

  const tagValues = normalizeArray(tags);
  if (tagValues.length) {
    conditions.push({ tags: { $in: tagValues } });
  }

  [country, state, city].forEach((value, index) => {
    if (!value) {
      return;
    }

    const field = locationFields[index];
    conditions.push({
      [field]: new RegExp(`^${escapeRegex(String(value).trim())}$`, "i"),
    });
  });

  rules.forEach((rule) => {
    const condition = buildRuleCondition(rule);

    if (condition) {
      conditions.push(condition);
    }
  });

  if (!conditions.length) {
    return {};
  }

  return conditions.length === 1 ? conditions[0] : { $and: conditions };
};

export { buildSubscriberMatch };
