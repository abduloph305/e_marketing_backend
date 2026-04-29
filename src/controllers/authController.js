import jwt from "jsonwebtoken";
import crypto from "crypto";
import Admin from "../models/Admin.js";
import { env } from "../config/env.js";
import { notifyVendorLogin } from "../services/adminNotificationService.js";
import { ensureVendorSubscription } from "../services/billingService.js";
import { syncVendorCustomersFromSellersLogin } from "../services/sellersloginAudienceSyncService.js";

const buildToken = (adminId) =>
  jwt.sign({ id: adminId }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

const setAuthCookie = (res, token) => {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: env.nodeEnv === "production" ? "none" : "lax",
    secure: env.nodeEnv === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();

const buildApiUrl = (baseUrl = "", path = "") => {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const suffix = String(path || "").trim().replace(/^\/+/, "");
  return base && suffix ? `${base}/${suffix}` : "";
};

const isVendorRole = (role = "") => String(role).trim().toLowerCase() === "vendor";

const randomLocalPassword = () => crypto.randomBytes(24).toString("base64url");

const getSellersLoginMessage = (data, fallback) =>
  data?.message || data?.error || fallback;

const loginWithSellersLoginVendor = async ({ email, password }) => {
  const url = buildApiUrl(env.sellersloginApiUrl, "auth/login");

  if (!url) {
    const error = new Error("SellersLogin authentication is not configured");
    error.status = 503;
    throw error;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.success) {
    const error = new Error(
      getSellersLoginMessage(data, "Unable to verify SellersLogin credentials"),
    );
    error.status = response.status;
    throw error;
  }

  const upstreamUser = data.data || {};

  if (!isVendorRole(upstreamUser.role)) {
    const error = new Error("Only vendor accounts can access Email Marketing");
    error.status = 403;
    throw error;
  }

  return {
    user: upstreamUser,
    token: data.token || data.accessToken || data.access_token || "",
  };
};

const upsertSellersLoginVendor = async (upstreamUser) => {
  const email = normalizeEmail(upstreamUser.email);
  const sellersloginVendorId = String(
    upstreamUser.vendor_id || upstreamUser.id || "",
  ).trim();
  const name = String(
    upstreamUser.vendor_name || upstreamUser.name || email.split("@")[0] || "Vendor",
  ).trim();
  const businessName = String(upstreamUser.vendor_name || upstreamUser.business_name || "").trim();

  if (!email || !sellersloginVendorId) {
    const error = new Error("SellersLogin vendor profile is incomplete");
    error.status = 400;
    throw error;
  }

  const existingUser = await Admin.findOne({
    $or: [{ email }, { sellersloginVendorId }],
  }).select("+password");

  const payload = {
    name,
    email,
    phone: String(upstreamUser.phone || "").trim(),
    businessName,
    sellersloginVendorId,
    sellersloginAccountType: String(upstreamUser.account_type || "").trim(),
    sellersloginActorId: String(upstreamUser.actor_id || "").trim(),
    sellersloginPageAccess: Array.isArray(upstreamUser.page_access)
      ? upstreamUser.page_access.map(String)
      : [],
    sellersloginWebsiteAccess: Array.isArray(upstreamUser.website_access)
      ? upstreamUser.website_access.map(String)
      : [],
    role: "vendor",
    accountStatus: "active",
  };

  if (existingUser) {
    Object.assign(existingUser, payload);

    if (!existingUser.password) {
      existingUser.password = randomLocalPassword();
    }

    await existingUser.save();
    return existingUser;
  }

  return Admin.create({
    ...payload,
    password: randomLocalPassword(),
  });
};

const syncSellersLoginAudienceForVendor = async ({ vendor, sellersloginToken = "" }) => {
  if (!vendor || vendor.role !== "vendor") {
    return { skipped: true, reason: "not_vendor" };
  }

  const vendorId = vendor.sellersloginVendorId || vendor.id || vendor._id;
  if (!vendorId || !sellersloginToken) {
    return { skipped: true, reason: sellersloginToken ? "missing_vendor_id" : "missing_sellerslogin_token" };
  }

  return syncVendorCustomersFromSellersLogin({
    vendorId,
    token: sellersloginToken,
  });
};

const loginAdmin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const normalizedEmail = normalizeEmail(email);
  const admin = await Admin.findOne({ email: normalizedEmail }).select(
    "+password",
  );

  if (admin?.password) {
    const isValidPassword = await admin.comparePassword(password);

    if (isValidPassword) {
      if (admin.accountStatus === "inactive") {
        return res.status(403).json({ message: "Your account has been deactivated" });
      }

      await Admin.updateOne(
        { _id: admin._id },
        {
          $set: {
            lastLoginAt: new Date(),
          },
        },
      );

      const token = buildToken(admin.id);
      setAuthCookie(res, token);

      const safeUser = admin.toSafeObject();

      await notifyVendorLogin(admin);

      let audienceSync = { skipped: true, reason: "not_vendor" };
      if (admin.role === "vendor") {
        loginWithSellersLoginVendor({ email: normalizedEmail, password })
          .then((upstreamSession) =>
            syncSellersLoginAudienceForVendor({
              vendor: admin,
              sellersloginToken: upstreamSession.token,
            }),
          )
          .then((result) => {
            console.log("SellersLogin customer audience sync completed", result);
          })
          .catch((error) => {
            console.error("SellersLogin customer audience sync failed", error?.message || error);
          });
        audienceSync = { queued: true };
      }

      return res.json({
        message: "Login successful",
        token,
        admin: safeUser,
        user: safeUser,
        audienceSync,
      });
    }
  }

  let vendorUser;

  try {
    const upstreamSession = await loginWithSellersLoginVendor({
      email: normalizedEmail,
      password,
    });
    const upstreamUser = upstreamSession.user;
    vendorUser = await upsertSellersLoginVendor(upstreamUser);
    vendorUser._sellersloginToken = upstreamSession.token;
  } catch (error) {
    return res.status(error.status || 401).json({
      message: error.status ? error.message : "Invalid credentials",
    });
  }

  await Admin.updateOne(
    { _id: vendorUser._id },
    { $set: { lastLoginAt: new Date() } },
  );
  await ensureVendorSubscription(vendorUser.sellersloginVendorId || vendorUser.id);

  let audienceSync = { queued: true };
  try {
    audienceSync = await syncSellersLoginAudienceForVendor({
      vendor: vendorUser,
      sellersloginToken: vendorUser._sellersloginToken,
    });
  } catch (error) {
    audienceSync = { skipped: true, error: error?.message || "Audience sync failed" };
    console.error("SellersLogin customer audience sync failed", error?.message || error);
  }

  const token = buildToken(vendorUser.id);
  setAuthCookie(res, token);
  const safeUser = vendorUser.toSafeObject();

  await notifyVendorLogin(vendorUser);

  return res.json({
    message: "Vendor login successful",
    token,
    admin: safeUser,
    user: safeUser,
    audienceSync,
  });
};

const logoutAdmin = async (_req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: env.nodeEnv === "production" ? "none" : "lax",
    secure: env.nodeEnv === "production",
  });

  return res.json({ message: "Logout successful" });
};

const getCurrentAdmin = async (req, res) => {
  const safeUser = req.admin.toSafeObject();
  return res.json({ admin: safeUser, user: safeUser });
};

export { loginAdmin, logoutAdmin, getCurrentAdmin };
