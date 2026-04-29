import crypto from "crypto";
import Subscriber from "../models/Subscriber.js";
import { env } from "../config/env.js";

const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_PAGES = Math.max(Number(process.env.SELLERSLOGIN_AUDIENCE_MAX_PAGES || 100), 1);
const INTERNAL_PAGE_LIMIT = Math.min(
  Math.max(Number(process.env.SELLERSLOGIN_AUDIENCE_INTERNAL_LIMIT || 500), 1),
  5000,
);
const TOKEN_PAGE_LIMIT = Math.min(
  Math.max(Number(process.env.SELLERSLOGIN_AUDIENCE_TOKEN_LIMIT || 200), 1),
  1000,
);
const STALE_GRACE_DAYS = Math.max(
  Number(process.env.SELLERSLOGIN_AUDIENCE_STALE_GRACE_DAYS || 7),
  1,
);
const HARD_DELETE_STALE =
  String(process.env.SELLERSLOGIN_AUDIENCE_HARD_DELETE || "").toLowerCase() === "true";
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const PROTECTED_STATUSES = new Set([
  "unsubscribed",
  "bounced",
  "complained",
  "suppressed",
  "blocked",
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();
const normalizeText = (value = "") => String(value || "").trim();

const logAudienceSync = (level, message, details = {}) => {
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  logger(`[sellerslogin:audience] ${message}`, details);
};

const buildApiUrl = (baseUrl = "", path = "") => {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const suffix = String(path || "").trim().replace(/^\/+/, "");
  return base && suffix ? `${base}/${suffix}` : "";
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const titleCase = (value = "") =>
  String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

const deriveNamesFromEmail = (email = "") => {
  const localPart = String(email).split("@")[0] || "customer";
  const nameParts = localPart.split(/[._-]+/).filter(Boolean);

  return {
    firstName: titleCase(nameParts[0] || "Customer"),
    lastName: titleCase(nameParts.slice(1).join(" ")) || "Subscriber",
  };
};

const splitName = (name = "", email = "") => {
  const derived = deriveNamesFromEmail(email);
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);

  return {
    firstName: parts[0] || derived.firstName,
    lastName: parts.slice(1).join(" ") || derived.lastName,
  };
};

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);

const normalizeTags = (...lists) =>
  Array.from(
    new Set(
      lists
        .flat()
        .map((tag) => String(tag || "").trim())
        .filter(Boolean),
    ),
  );

const isValidEmail = (email = "") => EMAIL_PATTERN.test(normalizeEmail(email));

const buildSyncRunId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;

const getRetryDelayMs = (attempt, response = null) => {
  const retryAfter = response?.headers?.get?.("retry-after");
  const retryAfterSeconds = Number(retryAfter);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 30 * 1000);
  }

  return Math.min(500 * 2 ** attempt, 8 * 1000);
};

const isRetryableError = (error) =>
  error?.name === "AbortError" ||
  error?.code === "ETIMEDOUT" ||
  error?.code === "ECONNRESET" ||
  error?.cause?.code === "ETIMEDOUT" ||
  error?.cause?.code === "ECONNRESET";

const fetchJson = async (url, options = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data = {};

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    return { response, data };
  } finally {
    clearTimeout(timeoutId);
  }
};

const fetchJsonWithRetry = async (url, options = {}, context = {}) => {
  const maxAttempts = Math.max(Number(options.maxAttempts || 3), 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await fetchJson(url, options);
      if (!RETRYABLE_STATUSES.has(result.response.status) || attempt === maxAttempts - 1) {
        return result;
      }

      await delay(getRetryDelayMs(attempt, result.response));
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxAttempts - 1) {
        const message =
          error?.name === "AbortError"
            ? "SellersLogin request timed out"
            : error?.message || "SellersLogin request failed";
        const nextError = new Error(message);
        nextError.cause = error;
        throw nextError;
      }

      await delay(getRetryDelayMs(attempt));
    }
  }

  throw lastError || new Error(`SellersLogin request failed for ${context.mode || "unknown"} sync`);
};

const extractCustomers = (data = {}) => {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.customers)) {
    return data.customers;
  }

  if (Array.isArray(data.data?.customers)) {
    return data.data.customers;
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (Array.isArray(data.results)) {
    return data.results;
  }

  return [];
};

const getPaginationMeta = (data = {}, page, customersLength) => {
  const source = data.data && !Array.isArray(data.data) ? data.data : data;
  const nextCursor = normalizeText(
    source.nextCursor ||
      source.next_cursor ||
      source.cursor?.next ||
      source.pageInfo?.nextCursor ||
      source.pagination?.nextCursor ||
      source.pagination?.next_cursor ||
      "",
  );
  const hasMoreValue =
    source.hasMore ??
    source.has_more ??
    source.pageInfo?.hasNextPage ??
    source.pagination?.hasMore ??
    source.pagination?.has_more;
  const totalPages = toFiniteNumber(
    source.totalPages || source.total_pages || source.pagination?.totalPages || source.pagination?.total_pages,
    0,
  );

  return {
    nextCursor,
    hasMore:
      typeof hasMoreValue === "boolean"
        ? hasMoreValue
        : Boolean(nextCursor) || (totalPages ? page < totalPages : false),
    totalPages,
  };
};

const shouldFetchNextPage = ({ meta, page, customersLength, limit, usedCursor }) => {
  if (page >= MAX_PAGES) {
    return false;
  }

  if (meta.nextCursor) {
    return true;
  }

  if (meta.hasMore) {
    return true;
  }

  if (meta.totalPages) {
    return page < meta.totalPages;
  }

  // Page+limit APIs often have no metadata; a full page is the only next-page hint.
  return usedCursor ? false : customersLength >= limit;
};

const normalizeCustomer = (customer = {}, vendorId = "", syncContext = {}) => {
  const email = normalizeEmail(customer.email);
  const { firstName, lastName } = splitName(customer.name, email);
  const websiteId = normalizeText(
    customer.website_id ||
      customer.source_website_id ||
      customer.websiteId ||
      syncContext.websiteId ||
      "",
  );
  const websiteName = normalizeText(
    customer.website_name ||
      customer.source_website_name ||
      customer.websiteName ||
      syncContext.websiteName ||
      "",
  );
  const websiteSlug = normalizeText(
    customer.website_slug ||
      customer.source_website_slug ||
      customer.websiteSlug ||
      syncContext.websiteSlug ||
      "",
  );
  const totalOrders = Math.max(
    toFiniteNumber(customer.orderCount ?? customer.totalOrders ?? customer.total_orders, 0),
    0,
  );
  const totalSpent = Math.max(
    toFiniteNumber(customer.totalSpent ?? customer.total_spent, 0),
    0,
  );
  const engagementScore = clampNumber(Math.round(totalOrders * 18 + totalSpent * 0.08), 0, 100);
  const nowIso = syncContext.syncedAt?.toISOString?.() || new Date().toISOString();

  return {
    vendorId: normalizeText(vendorId),
    firstName,
    lastName,
    email,
    phone: normalizeText(customer.phone),
    status: customer.is_active === false ? "unsubscribed" : "subscribed",
    source: "website_signup",
    sourceLocation: "vendor_website",
    tags: normalizeTags(
      "sellerslogin_customer",
      customer.source === "template" ? "template_customer" : "customer",
    ),
    totalOrders,
    totalSpent,
    lastOrderDate: customer.lastOrderAt || customer.lastOrderDate || null,
    lastActivityAt: customer.lastOrderAt || customer.updatedAt || customer.createdAt || syncContext.syncedAt || new Date(),
    engagementScore,
    customFields: {
      audienceSynced: true,
      audienceSyncSource: "sellerslogin_customers",
      audienceSourceSystem: "sellerslogin",
      audienceSourceLocation: "vendor_website",
      audienceSourceUserId: normalizeText(customer._id || customer.id),
      audienceSourceVendorId: normalizeText(customer.vendor_id || customer.vendorId || vendorId),
      audienceSourceWebsiteId: websiteId,
      audienceSourceWebsiteSlug: websiteSlug,
      audienceSourceWebsiteName: websiteName,
      audienceSyncedAt: nowIso,
      audienceSyncRunId: syncContext.syncRunId,
      audienceArchived: false,
      sourceLocations: ["vendor_website"],
    },
  };
};

const buildSubscriberUpdate = (existing = null, payload = {}) => {
  const currentCustomFields = existing?.customFields || {};
  const nextStatus =
    existing && PROTECTED_STATUSES.has(existing.status) ? existing.status : payload.status;

  return {
    firstName: payload.firstName,
    lastName: payload.lastName,
    email: payload.email,
    phone: payload.phone,
    status: nextStatus,
    source: existing?.source || payload.source,
    sourceLocation: existing?.sourceLocation || payload.sourceLocation,
    tags: normalizeTags(existing?.tags, payload.tags),
    totalOrders: Math.max(toFiniteNumber(existing?.totalOrders, 0), payload.totalOrders),
    totalSpent: Math.max(toFiniteNumber(existing?.totalSpent, 0), payload.totalSpent),
    lastOrderDate: payload.lastOrderDate || existing?.lastOrderDate || null,
    lastActivityAt: payload.lastActivityAt || existing?.lastActivityAt || new Date(),
    engagementScore: payload.engagementScore,
    customFields: {
      ...currentCustomFields,
      ...payload.customFields,
      sourceLocations: normalizeTags(
        currentCustomFields.sourceLocations,
        payload.customFields.sourceLocations,
      ),
    },
  };
};

const buildEmptyResult = (overrides = {}) => ({
  skipped: false,
  mode: overrides.mode || "internal",
  imported: 0,
  updated: 0,
  staleMarked: 0,
  removed: 0,
  sourceCount: 0,
  total: 0,
  skippedWithoutEmail: 0,
  duplicateEmailRows: 0,
  duplicateEmails: [],
  pagesFetched: 0,
  syncRunId: overrides.syncRunId || "",
  warnings: [],
  ...overrides,
});

const markStaleSubscribers = async ({ vendorId, syncRunId, syncedAt, warnings = [] }) => {
  const staleBefore = new Date(syncedAt.getTime() - STALE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const staleMatch = {
    vendorId,
    "customFields.audienceSyncSource": "sellerslogin_customers",
    "customFields.audienceSyncRunId": { $ne: syncRunId },
    "customFields.audienceSyncedAt": { $lt: staleBefore.toISOString() },
  };

  if (HARD_DELETE_STALE) {
    const result = await Subscriber.deleteMany(staleMatch);
    warnings.push("Hard delete for stale SellersLogin subscribers is enabled");
    return { staleMarked: 0, removed: result.deletedCount || 0 };
  }

  const markResult = await Subscriber.updateMany(
    staleMatch,
    {
      $set: {
        "customFields.audienceArchived": true,
        "customFields.audienceStaleAt": syncedAt.toISOString(),
        "customFields.audienceMissingFromRunId": syncRunId,
      },
    },
  );
  await Subscriber.updateMany(
    {
      ...staleMatch,
      status: { $nin: Array.from(PROTECTED_STATUSES) },
    },
    {
      $set: {
        status: "unsubscribed",
      },
    },
  );

  return { staleMarked: markResult.modifiedCount || 0, removed: 0 };
};

const upsertVendorCustomers = async ({
  vendorId,
  customers = [],
  syncRunId = buildSyncRunId(),
  syncedAt = new Date(),
  pagesFetched = 0,
  mode = "manual",
  websiteId = "",
} = {}) => {
  const normalizedVendorId = normalizeText(vendorId);
  const warnings = [];
  let skippedWithoutEmail = 0;
  let duplicateEmailRows = 0;
  const seenEmails = new Set();
  const duplicateEmails = new Set();
  const payloadsByEmail = new Map();

  if (!normalizedVendorId) {
    throw new Error("Vendor id is required for audience sync");
  }

  for (const customer of Array.isArray(customers) ? customers : []) {
    const payload = normalizeCustomer(customer, normalizedVendorId, {
      syncRunId,
      syncedAt,
      websiteId: normalizeText(websiteId),
    });
    if (!payload.email || !isValidEmail(payload.email)) {
      skippedWithoutEmail += 1;
      continue;
    }

    if (seenEmails.has(payload.email)) {
      duplicateEmailRows += 1;
      duplicateEmails.add(payload.email);
    }

    seenEmails.add(payload.email);
    payloadsByEmail.set(payload.email, payload);
  }

  const emails = Array.from(payloadsByEmail.keys());
  const existingSubscribers = emails.length
    ? await Subscriber.find({ vendorId: normalizedVendorId, email: { $in: emails } }).lean()
    : [];
  const existingByEmail = new Map(existingSubscribers.map((subscriber) => [subscriber.email, subscriber]));
  const operations = emails.map((email) => {
    const payload = payloadsByEmail.get(email);
    const existing = existingByEmail.get(email);
    const update = buildSubscriberUpdate(existing, payload);

    return {
      updateOne: {
        filter: { vendorId: normalizedVendorId, email },
        update: {
          $set: update,
          $setOnInsert: {
            vendorId: normalizedVendorId,
            createdAt: syncedAt,
          },
        },
        upsert: true,
        runValidators: true,
      },
    };
  });

  let imported = 0;
  let updated = 0;

  if (operations.length) {
    try {
      const bulkResult = await Subscriber.bulkWrite(operations, { ordered: false });
      imported = bulkResult.upsertedCount || 0;
      updated = bulkResult.matchedCount || 0;
    } catch (error) {
      const writeErrors = error?.writeErrors || error?.result?.result?.writeErrors || [];
      const duplicateKeyErrors = writeErrors.filter((item) => item?.code === 11000);
      const fatalErrors = writeErrors.filter((item) => item?.code !== 11000);

      if (fatalErrors.length || !duplicateKeyErrors.length) {
        throw error;
      }

      warnings.push(`${duplicateKeyErrors.length} duplicate key race(s) were skipped during bulk upsert`);
      imported = error?.result?.upsertedCount || error?.result?.result?.nUpserted || 0;
      const retryOperations = operations.map((operation) => ({
        updateOne: {
          ...operation.updateOne,
          upsert: false,
        },
      }));
      const retryResult = await Subscriber.bulkWrite(retryOperations, { ordered: false });
      updated = retryResult.matchedCount || error?.result?.matchedCount || error?.result?.result?.nMatched || 0;
    }
  }

  const staleResult = await markStaleSubscribers({
    vendorId: normalizedVendorId,
    syncRunId,
    syncedAt,
    warnings,
  });

  return buildEmptyResult({
    skipped: false,
    mode,
    imported,
    updated,
    staleMarked: staleResult.staleMarked,
    removed: staleResult.removed,
    sourceCount: Array.isArray(customers) ? customers.length : 0,
    total: emails.length,
    skippedWithoutEmail,
    duplicateEmailRows,
    duplicateEmails: Array.from(duplicateEmails).slice(0, 10),
    pagesFetched,
    syncRunId,
    warnings,
  });
};

const fetchPaginatedCustomers = async ({
  url,
  headers,
  baseQuery = {},
  limit,
  mode,
  vendorId = "",
  websiteId = "",
}) => {
  const customers = [];
  let page = 1;
  let cursor = "";
  let pagesFetched = 0;
  const pageSignatures = new Set();

  while (page <= MAX_PAGES) {
    const query = new URLSearchParams({
      ...baseQuery,
      limit: String(limit),
      page: String(page),
    });

    if (websiteId) {
      query.set("website_id", websiteId);
    }

    if (cursor) {
      query.set("cursor", cursor);
    }

    const { response, data } = await fetchJsonWithRetry(`${url}?${query.toString()}`, {
      headers,
    }, { mode, vendorId });

    if (!response.ok) {
      const message = data?.message || data?.error || `Unable to fetch SellersLogin customers (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    const pageCustomers = extractCustomers(data);
    const meta = getPaginationMeta(data, page, pageCustomers.length);
    const pageSignature = JSON.stringify(
      pageCustomers.map((customer) => customer?._id || customer?.id || customer?.email || "").slice(0, 5),
    );

    if (page > 1 && pageSignature && pageSignatures.has(pageSignature)) {
      logAudienceSync("warn", "duplicate page detected; stopping pagination", {
        vendorId,
        websiteId,
        mode,
        page,
      });
      break;
    }

    pageSignatures.add(pageSignature);
    customers.push(...pageCustomers);
    pagesFetched += 1;

    if (!shouldFetchNextPage({
      meta,
      page,
      customersLength: pageCustomers.length,
      limit,
      usedCursor: Boolean(cursor),
    })) {
      break;
    }

    cursor = meta.nextCursor;
    page += 1;
  }

  if (page > MAX_PAGES) {
    logAudienceSync("warn", "max page guard reached", { vendorId, websiteId, mode, maxPages: MAX_PAGES });
  }

  return { customers, pagesFetched };
};

const fetchVendorCustomersWithToken = async ({ token, websiteId = "", vendorId = "" }) => {
  const url = buildApiUrl(env.sellersloginApiUrl, "vendor/customers");
  if (!url) {
    throw new Error("SellersLogin API URL is not configured");
  }

  return fetchPaginatedCustomers({
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    limit: TOKEN_PAGE_LIMIT,
    mode: "vendor_token",
    vendorId,
    websiteId,
  });
};

const fetchVendorCustomersWithInternalSecret = async ({ vendorId, websiteId = "" }) => {
  const url = buildApiUrl(env.sellersloginApiUrl, "internal/marketing/vendor-customers");
  const secret = normalizeText(
    env.ophmateWebhookSecret ||
      process.env.MARKETING_WEBHOOK_SECRET ||
      process.env.MARKETING_INTERNAL_SECRET,
  );

  if (!url || !secret) {
    throw new Error("SellersLogin internal audience sync is not configured");
  }

  return fetchPaginatedCustomers({
    url,
    headers: {
      "x-integration-secret": secret,
    },
    baseQuery: {
      vendor_id: normalizeText(vendorId),
    },
    limit: INTERNAL_PAGE_LIMIT,
    mode: "internal",
    vendorId,
    websiteId,
  });
};

const syncVendorCustomersFromSellersLogin = async ({ vendorId, token = "", websiteId = "" }) => {
  const normalizedVendorId = normalizeText(vendorId);
  const normalizedWebsiteId = normalizeText(websiteId);
  const syncRunId = buildSyncRunId();
  const syncedAt = new Date();
  let customers = [];
  let pagesFetched = 0;
  let mode = "internal";

  logAudienceSync("info", "sync started", {
    vendorId: normalizedVendorId,
    websiteId: normalizedWebsiteId,
    mode,
    syncRunId,
  });

  try {
    const internalResult = await fetchVendorCustomersWithInternalSecret({
      vendorId: normalizedVendorId,
      websiteId: normalizedWebsiteId,
    });
    customers = internalResult.customers;
    pagesFetched = internalResult.pagesFetched;
  } catch (internalError) {
    logAudienceSync("warn", "internal sync unavailable, checking fallback", {
      vendorId: normalizedVendorId,
      websiteId: normalizedWebsiteId,
      mode,
      error: internalError?.message || "Internal sync failed",
    });

    if (!token) {
      const skippedResult = buildEmptyResult({
        skipped: true,
        mode,
        syncRunId,
        warnings: [internalError?.message || "Internal sync failed"],
        reason: "internal_sync_failed",
        error: internalError?.message || "Internal sync failed",
      });

      logAudienceSync("warn", "sync skipped", {
        vendorId: normalizedVendorId,
        websiteId: normalizedWebsiteId,
        mode,
        syncRunId,
        reason: skippedResult.reason,
      });

      return skippedResult;
    }

    mode = "vendor_token";
    logAudienceSync("info", "using vendor token fallback", {
      vendorId: normalizedVendorId,
      websiteId: normalizedWebsiteId,
      mode,
      syncRunId,
    });
    const tokenResult = await fetchVendorCustomersWithToken({
      token,
      vendorId: normalizedVendorId,
      websiteId: normalizedWebsiteId,
    });
    customers = tokenResult.customers;
    pagesFetched = tokenResult.pagesFetched;
  }

  try {
    const result = await upsertVendorCustomers({
      vendorId: normalizedVendorId,
      customers,
      syncRunId,
      syncedAt,
      pagesFetched,
      mode,
      websiteId: normalizedWebsiteId,
    });

    logAudienceSync("info", "sync completed", {
      vendorId: normalizedVendorId,
      websiteId: normalizedWebsiteId,
      mode,
      sourceCount: result.sourceCount,
      imported: result.imported,
      updated: result.updated,
      staleMarked: result.staleMarked,
      removed: result.removed,
      skippedWithoutEmail: result.skippedWithoutEmail,
      duplicateEmailRows: result.duplicateEmailRows,
      duplicateEmails: result.duplicateEmails.length,
      pagesFetched: result.pagesFetched,
      syncRunId,
    });

    return result;
  } catch (error) {
    logAudienceSync("error", "sync failed", {
      vendorId: normalizedVendorId,
      websiteId: normalizedWebsiteId,
      mode,
      sourceCount: customers.length,
      pagesFetched,
      syncRunId,
      error: error?.message || "Audience sync failed",
    });
    throw error;
  }
};

export {
  syncVendorCustomersFromSellersLogin,
  upsertVendorCustomers,
};
