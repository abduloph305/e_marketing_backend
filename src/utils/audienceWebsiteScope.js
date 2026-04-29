const normalizeText = (value = "") => String(value || "").trim();

const normalizeWebsiteScope = (input = {}) => {
  const source = input.websiteScope || input;
  const websiteId = normalizeText(source.websiteId || source.website_id);
  const websiteSlug = normalizeText(source.websiteSlug || source.website_slug);
  const websiteName = normalizeText(source.websiteName || source.website_name);
  const label = normalizeText(source.label) || websiteName || websiteSlug || websiteId;

  if (!websiteId && !websiteSlug && !websiteName) {
    return {
      websiteId: "",
      websiteSlug: "",
      websiteName: "",
      label: "",
    };
  }

  return {
    websiteId,
    websiteSlug,
    websiteName,
    label,
  };
};

const hasWebsiteScope = (scope = {}) =>
  Boolean(scope?.websiteId || scope?.websiteSlug || scope?.websiteName);

const buildExactMatch = (value) => new RegExp(`^${normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

const buildWebsiteScopeMatch = (scope = {}) => {
  const normalized = normalizeWebsiteScope(scope);
  const conditions = [];

  if (normalized.websiteId) {
    conditions.push({ "customFields.audienceSourceWebsiteId": buildExactMatch(normalized.websiteId) });
  }

  if (normalized.websiteSlug) {
    conditions.push({ "customFields.audienceSourceWebsiteSlug": buildExactMatch(normalized.websiteSlug) });
  }

  if (normalized.websiteName) {
    conditions.push({ "customFields.audienceSourceWebsiteName": buildExactMatch(normalized.websiteName) });
  }

  if (!conditions.length) {
    return {};
  }

  return conditions.length === 1 ? conditions[0] : { $or: conditions };
};

const combineAudienceMatches = (...matches) => {
  const conditions = matches.filter((match) => match && Object.keys(match).length);

  if (!conditions.length) {
    return {};
  }

  return conditions.length === 1 ? conditions[0] : { $and: conditions };
};

export {
  buildWebsiteScopeMatch,
  combineAudienceMatches,
  hasWebsiteScope,
  normalizeWebsiteScope,
};
