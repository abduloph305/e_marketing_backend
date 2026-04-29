import Subscriber from "../models/Subscriber.js";
import { env } from "../config/env.js";

const REQUEST_TIMEOUT_MS = 10 * 1000;
const CACHE_TTL_MS = 30 * 1000;

const SITE_DEFINITIONS = [
  {
    key: "main_website",
    label: "Main website",
    apiUrl: env.ophmateInternalApiUrl,
    email: env.ophmateInternalEmail,
    password: env.ophmateInternalPassword,
    sourceLocation: "main_website",
  },
  {
    key: "vendor_website",
    label: "Vendor website",
    apiUrl: env.vendorInternalApiUrl,
    email: env.vendorInternalEmail,
    password: env.vendorInternalPassword,
    sourceLocation: "vendor_website",
  },
];

const cacheBySite = new Map();

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

const hasSyncConfig = (site) =>
  Boolean(site.apiUrl && site.email && site.password);

const normalizeEmail = (value = "") => String(value || "").trim().toLowerCase();

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
      lastName: "Member",
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

const normalizeTags = (tags = []) =>
  Array.from(
    new Set(
      (Array.isArray(tags) ? tags : String(tags).split(","))
        .map((tag) => String(tag).trim())
        .filter(Boolean),
    ),
  );

const normalizeCustomFields = (value = {}) => {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  return value;
};

const normalizeSiteUser = (user = {}, site) => {
  const email = normalizeEmail(user.email || "");
  const derivedNames = deriveNamesFromEmail(email);
  const customFields = normalizeCustomFields(user.customFields);
  const sourceLocations = normalizeTags([
    ...(Array.isArray(customFields.sourceLocations) ? customFields.sourceLocations : []),
    site.sourceLocation,
  ]);

  return {
    firstName: String(user.firstName || user.name?.split(/\s+/)?.[0] || derivedNames.firstName || "").trim(),
    lastName: String(
      user.lastName ||
        user.name?.split(/\s+/)?.slice(1).join(" ") ||
        derivedNames.lastName ||
        "",
    ).trim(),
    email,
    phone: String(user.phone || "").trim(),
    status: String(user.status || "subscribed").trim(),
    source: String(user.source || "website_signup").trim() || "website_signup",
    sourceLocation: site.sourceLocation,
    tags: normalizeTags([...(Array.isArray(user.tags) ? user.tags : []), ...(Array.isArray(customFields.tags) ? customFields.tags : [])]),
    city: String(user.city || "").trim(),
    state: String(user.state || "").trim(),
    country: String(user.country || "").trim(),
    totalOrders: Number(user.totalOrders || 0),
    totalSpent: Number(user.totalSpent || 0),
    lastOrderDate: user.lastOrderDate || null,
    lastEmailSentAt: user.lastEmailSentAt || null,
    lastOpenAt: user.lastOpenAt || null,
    lastClickAt: user.lastClickAt || null,
    notes: String(user.notes || "").trim(),
    customFields: {
      ...customFields,
      audienceSynced: true,
      audienceSyncSource: site.key,
      audienceSourceLocation: site.sourceLocation,
      audienceSourceSystem: site.key,
      audienceSourceUserId: user._id || user.id || user.userId || "",
      audienceSourceVendorId: user.vendor_id || user.vendorId || "",
      audienceSourceWebsiteId: user.website_id || user.websiteId || "",
      audienceSourceWebsiteSlug: user.website_slug || user.websiteSlug || "",
      audienceSyncedAt: new Date().toISOString(),
      sourceLocations,
    },
  };
};

const loginToSite = async (site) => {
  const { response, data } = await fetchJson(`${site.apiUrl}/auth/login`, {
    method: "POST",
    body: JSON.stringify({
      email: site.email,
      password: site.password,
    }),
  });

  if (response.status !== 200 || !data?.token) {
    throw new Error(data?.message || `Unable to authenticate with ${site.label.toLowerCase()}`);
  }

  return data.token;
};

const fetchSiteUsers = async (site, token) => {
  const users = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    const { response, data } = await fetchJson(
      `${site.apiUrl}/users/getall?${query.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (response.status !== 200) {
      throw new Error(data?.message || `Unable to fetch ${site.label.toLowerCase()} users`);
    }

    const batch = Array.isArray(data?.users) ? data.users : [];
    users.push(...batch);

    const totalPages = Number(data?.pagination?.totalPages || 1);
    if (page >= totalPages || !batch.length) {
      break;
    }

    page += 1;
  }

  return users;
};

const refreshSiteCache = async (site) => {
  if (!hasSyncConfig(site)) {
    return { skipped: true, users: [], emails: new Set(), fetchedAt: 0 };
  }

  const cached = cacheBySite.get(site.key);
  const now = Date.now();

  if (cached && cached.fetchedAt && now - cached.fetchedAt < CACHE_TTL_MS && cached.emails.size) {
    return cached;
  }

  const token = await loginToSite(site);
  const users = await fetchSiteUsers(site, token);
  const emails = new Set(
    users
      .map((user) => normalizeEmail(user?.email || ""))
      .filter(Boolean),
  );

  const nextCache = {
    skipped: false,
    fetchedAt: now,
    token,
    users,
    emails,
  };

  cacheBySite.set(site.key, nextCache);
  return nextCache;
};

const mergeSourceLocations = (currentSubscriber, nextLocation) => {
  const currentLocations = normalizeTags([
    currentSubscriber?.sourceLocation || "",
    ...(Array.isArray(currentSubscriber?.customFields?.sourceLocations)
      ? currentSubscriber.customFields.sourceLocations
      : []),
  ]);

  return normalizeTags([...currentLocations, nextLocation]);
};

const upsertSiteUsers = async (site, users = []) => {
  let imported = 0;
  let updated = 0;

  for (const user of users) {
    const payload = normalizeSiteUser(user, site);
    const vendorId = String(
      payload.customFields?.audienceSourceVendorId ||
        user.vendor_id ||
        user.vendorId ||
        "",
    ).trim();

    if (!payload.email || !vendorId) {
      continue;
    }

    payload.vendorId = vendorId;

    const existing = await Subscriber.findOne({ vendorId, email: payload.email });
    const nextSourceLocations = existing
      ? mergeSourceLocations(existing, site.sourceLocation)
      : [site.sourceLocation];

    const nextPayload = {
      ...payload,
      sourceLocation: existing?.sourceLocation && existing.sourceLocation !== "manual"
        ? existing.sourceLocation
        : site.sourceLocation,
      customFields: {
        ...(existing?.customFields || {}),
        ...payload.customFields,
        sourceLocations: nextSourceLocations,
        audienceSynced: true,
      },
      tags: normalizeTags([...(existing?.tags || []), ...(payload.tags || [])]),
      totalOrders: Math.max(Number(existing?.totalOrders || 0), Number(payload.totalOrders || 0)),
      totalSpent: Math.max(Number(existing?.totalSpent || 0), Number(payload.totalSpent || 0)),
      lastOrderDate: payload.lastOrderDate || existing?.lastOrderDate || null,
      lastEmailSentAt: payload.lastEmailSentAt || existing?.lastEmailSentAt || null,
      lastOpenAt: payload.lastOpenAt || existing?.lastOpenAt || null,
      lastClickAt: payload.lastClickAt || existing?.lastClickAt || null,
      lastActivityAt: new Date(),
      engagementScore:
        Number(existing?.engagementScore || 0) ||
        (payload.totalOrders ? Math.round(Number(payload.totalOrders || 0) * 18) : 0),
    };

    if (existing) {
      await Subscriber.findByIdAndUpdate(existing._id, nextPayload, {
        returnDocument: "after",
        runValidators: true,
      });
      updated += 1;
    } else {
      await Subscriber.create(nextPayload);
      imported += 1;
    }
  }

  return { imported, updated };
};

const cleanupStaleSyncedUsers = async (activePairs = new Set()) => {
  const staleSubscribers = await Subscriber.find({
    "customFields.audienceSynced": true,
  })
    .select("_id email vendorId")
    .lean();

  const staleIds = staleSubscribers
    .filter((subscriber) => {
      const email = normalizeEmail(subscriber?.email || "");
      const vendorId = String(subscriber?.vendorId || "").trim();
      return email && vendorId && !activePairs.has(`${vendorId}:${email}`);
    })
    .map((subscriber) => subscriber._id);

  if (!staleIds.length) {
    return 0;
  }

  const result = await Subscriber.deleteMany({ _id: { $in: staleIds } });
  return result.deletedCount || staleIds.length;
};

const syncWebsiteAudience = async () => {
  const configuredSites = SITE_DEFINITIONS.filter(hasSyncConfig);
  const results = {
    mainWebsite: { skipped: true, imported: 0, updated: 0, users: 0 },
    vendorWebsite: { skipped: true, imported: 0, updated: 0, users: 0 },
    deletedCount: 0,
  };

  const activePairs = new Set();

  for (const site of SITE_DEFINITIONS) {
    const cache = await refreshSiteCache(site);
    if (cache?.skipped) {
      continue;
    }

    const syncResult = await upsertSiteUsers(site, cache.users);
    cache.users.forEach((user) => {
      const email = normalizeEmail(user?.email || "");
      const vendorId = String(user?.vendor_id || user?.vendorId || "").trim();
      if (email && vendorId) {
        activePairs.add(`${vendorId}:${email}`);
      }
    });

    if (site.key === "main_website") {
      results.mainWebsite = {
        skipped: false,
        ...syncResult,
        users: cache.users.length,
      };
    } else if (site.key === "vendor_website") {
      results.vendorWebsite = {
        skipped: false,
        ...syncResult,
        users: cache.users.length,
      };
    }
  }

  if (configuredSites.length === SITE_DEFINITIONS.length && activePairs.size) {
    results.deletedCount = await cleanupStaleSyncedUsers(activePairs);
  }
  return results;
};

export { syncWebsiteAudience, refreshSiteCache };
