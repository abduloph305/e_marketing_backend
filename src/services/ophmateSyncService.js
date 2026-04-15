import Subscriber from "../models/Subscriber.js";
import { env } from "../config/env.js";

const cache = {
  fetchedAt: 0,
  token: "",
  emails: new Set(),
  userIds: new Set(),
};

const CACHE_TTL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

const hasSyncConfig = () =>
  Boolean(env.ophmateInternalApiUrl && env.ophmateInternalEmail && env.ophmateInternalPassword);

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

const loginToOphmate = async () => {
  const { response, data } = await fetchJson(`${env.ophmateInternalApiUrl}/auth/login`, {
    method: "POST",
    body: JSON.stringify({
      email: env.ophmateInternalEmail,
      password: env.ophmateInternalPassword,
    }),
  });

  if (response.status !== 200 || !data?.token) {
    throw new Error(data?.message || "Unable to authenticate with OphMate");
  }

  return data.token;
};

const fetchOphmateUsers = async (token) => {
  const users = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    const { response, data } = await fetchJson(
      `${env.ophmateInternalApiUrl}/users/getall?${query.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (response.status !== 200) {
      throw new Error(data?.message || "Unable to fetch OphMate users");
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

const refreshOphmateUserCache = async () => {
  if (!hasSyncConfig()) {
    return cache;
  }

  const now = Date.now();
  if (cache.fetchedAt && now - cache.fetchedAt < CACHE_TTL_MS && cache.userIds.size) {
    return cache;
  }

  const token = await loginToOphmate();
  const users = await fetchOphmateUsers(token);

  cache.fetchedAt = now;
  cache.token = token;
  cache.userIds = new Set(
    users
      .map((user) => String(user?._id || user?.id || "").trim())
      .filter(Boolean),
  );
  cache.emails = new Set(
    users
      .map((user) => String(user?.email || "").trim().toLowerCase())
      .filter(Boolean),
  );

  return cache;
};

const cleanupDeletedWebsiteSubscribers = async () => {
  if (!hasSyncConfig()) {
    return { skipped: true, deletedCount: 0 };
  }

  const source = await refreshOphmateUserCache();
  const candidates = await Subscriber.find({
    $or: [
      { source: "website_signup" },
      { "customFields.ophmateEventType": "user.registered" },
    ],
  })
    .select("_id email source customFields")
    .lean();

  const deleteIds = candidates
    .filter((subscriber) => {
      const userId = String(subscriber?.customFields?.ophmateUserId || "").trim();
      const email = String(subscriber?.email || "").trim().toLowerCase();

      if (userId) {
        return !source.userIds.has(userId);
      }

      return email ? !source.emails.has(email) : false;
    })
    .map((subscriber) => subscriber._id);

  if (!deleteIds.length) {
    return { skipped: false, deletedCount: 0 };
  }

  const result = await Subscriber.deleteMany({ _id: { $in: deleteIds } });

  return {
    skipped: false,
    deletedCount: result.deletedCount || deleteIds.length,
  };
};

export { cleanupDeletedWebsiteSubscribers, refreshOphmateUserCache };
