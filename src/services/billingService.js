import BillingInvoice from "../models/BillingInvoice.js";
import BillingPayment from "../models/BillingPayment.js";
import BillingPlan from "../models/BillingPlan.js";
import EmailTemplate from "../models/EmailTemplate.js";
import AutomationWorkflow from "../models/AutomationWorkflow.js";
import Segment from "../models/Segment.js";
import Admin from "../models/Admin.js";
import UsageLedger from "../models/UsageLedger.js";
import VendorSubscription from "../models/VendorSubscription.js";
import { env } from "../config/env.js";
import crypto from "crypto";
import { isValidObjectId } from "mongoose";

const defaultPlans = [
  {
    name: "Free Plan",
    slug: "free",
    description: "Entry plan for new vendors testing email marketing.",
    monthlyPrice: 0,
    yearlyPrice: 0,
    emailsPerDay: 100,
    emailsPerMonth: 3000,
    features: ["100 emails per day", "Basic campaigns", "Standard templates"],
    limits: { automations: 0, teamMembers: 1, templates: 5, segments: 3 },
    isActive: true,
    isDefault: true,
    sortOrder: 1,
  },
  {
    name: "Starter Plan",
    slug: "starter",
    description: "For growing stores sending regular campaigns.",
    monthlyPrice: 999,
    yearlyPrice: 9990,
    emailsPerDay: 1000,
    emailsPerMonth: 10000,
    features: ["10,000 emails per month", "Basic automation", "Segments", "Email support"],
    limits: { automations: 5, teamMembers: 3, templates: 25, segments: 20 },
    isActive: true,
    isDefault: false,
    sortOrder: 2,
  },
  {
    name: "Pro Plan",
    slug: "pro",
    description: "For high volume stores with advanced marketing needs.",
    monthlyPrice: 4999,
    yearlyPrice: 49990,
    emailsPerDay: 10000,
    emailsPerMonth: 100000,
    features: ["100,000 emails per month", "Advanced automation", "Priority support", "Advanced reports"],
    limits: { automations: 50, teamMembers: 10, templates: 100, segments: 100 },
    isActive: true,
    isDefault: false,
    sortOrder: 3,
  },
];

const startOfDay = (date = new Date()) => {
  const nextDate = new Date(date);
  nextDate.setHours(0, 0, 0, 0);
  return nextDate;
};

const startOfMonth = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), 1);

const addPeriod = (billingCycle = "monthly", date = new Date()) => {
  const nextDate = new Date(date);
  if (billingCycle === "yearly") {
    nextDate.setFullYear(nextDate.getFullYear() + 1);
    return nextDate;
  }

  nextDate.setMonth(nextDate.getMonth() + 1);
  return nextDate;
};

const normalizeSlug = (value = "") =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const ensureDefaultPlans = async () => {
  for (const plan of defaultPlans) {
    await BillingPlan.updateOne(
      { slug: plan.slug },
      {
        $setOnInsert: plan,
      },
      { upsert: true },
    );
  }

  return BillingPlan.find({ isActive: true }).sort({ sortOrder: 1, monthlyPrice: 1 });
};

const getDefaultPlan = async () => {
  await ensureDefaultPlans();
  return BillingPlan.findOne({ isDefault: true, isActive: true }).sort({ sortOrder: 1 });
};

const ensureVendorSubscription = async (vendorId) => {
  const normalizedVendorId = String(vendorId || "").trim();
  if (!normalizedVendorId) {
    return null;
  }

  const existingSubscription = await VendorSubscription.findOne({ vendorId: normalizedVendorId }).populate("planId");
  if (existingSubscription) {
    return existingSubscription;
  }

  const defaultPlan = await getDefaultPlan();
  const now = new Date();

  return VendorSubscription.create({
    vendorId: normalizedVendorId,
    planId: defaultPlan._id,
    status: "free",
    billingCycle: "monthly",
    gateway: "none",
    currentPeriodStart: now,
    currentPeriodEnd: addPeriod("monthly", now),
  });
};

const getUsageSummary = async (vendorId) => {
  const normalizedVendorId = String(vendorId || "").trim();
  const now = new Date();
  const [dailyRows, monthlyRows] = await Promise.all([
    UsageLedger.aggregate([
      {
        $match: {
          vendorId: normalizedVendorId,
          type: "email_send",
          occurredAt: { $gte: startOfDay(now) },
        },
      },
      { $group: { _id: null, total: { $sum: "$count" } } },
    ]),
    UsageLedger.aggregate([
      {
        $match: {
          vendorId: normalizedVendorId,
          type: "email_send",
          occurredAt: { $gte: startOfMonth(now) },
        },
      },
      { $group: { _id: null, total: { $sum: "$count" } } },
    ]),
  ]);

  return {
    emailsSentToday: dailyRows[0]?.total || 0,
    emailsSentThisMonth: monthlyRows[0]?.total || 0,
  };
};

const createFeatureLimit = (used = 0, limit = 0) => {
  const normalizedUsed = Number(used || 0);
  const normalizedLimit = Number(limit || 0);

  return {
    used: normalizedUsed,
    limit: normalizedLimit,
    remaining: Math.max(normalizedLimit - normalizedUsed, 0),
    isLimited: normalizedLimit > 0,
    isExhausted: normalizedLimit <= 0 || normalizedUsed >= normalizedLimit,
  };
};

const getTeamMemberCount = async (vendorId) => {
  const normalizedVendorId = String(vendorId || "").trim();
  const ownershipMatch = [{ sellersloginVendorId: normalizedVendorId }];

  if (isValidObjectId(normalizedVendorId)) {
    ownershipMatch.push({ _id: normalizedVendorId });
  }

  return Admin.countDocuments({
    role: { $ne: "super_admin" },
    $or: ownershipMatch,
  });
};

const getFeatureUsageSummary = async (vendorId, plan = {}) => {
  const normalizedVendorId = String(vendorId || "").trim();
  if (!normalizedVendorId) {
    return {
      automations: createFeatureLimit(0, plan.limits?.automations || 0),
      teamMembers: createFeatureLimit(0, plan.limits?.teamMembers || 0),
      templates: createFeatureLimit(0, plan.limits?.templates || 0),
      segments: createFeatureLimit(0, plan.limits?.segments || 0),
    };
  }

  const [templates, automations, segments, teamMembers] = await Promise.all([
    EmailTemplate.countDocuments({ vendorId: normalizedVendorId }),
    AutomationWorkflow.countDocuments({ vendorId: normalizedVendorId }),
    Segment.countDocuments({ vendorId: normalizedVendorId }),
    getTeamMemberCount(normalizedVendorId),
  ]);

  return {
    automations: createFeatureLimit(automations, plan.limits?.automations || 0),
    teamMembers: createFeatureLimit(teamMembers, plan.limits?.teamMembers || 0),
    templates: createFeatureLimit(templates, plan.limits?.templates || 0),
    segments: createFeatureLimit(segments, plan.limits?.segments || 0),
  };
};

const getSubscriptionSnapshot = async (vendorId) => {
  const subscription = await ensureVendorSubscription(vendorId);
  if (!subscription) {
    return null;
  }

  const populatedSubscription = subscription.populate
    ? await subscription.populate("planId")
    : await VendorSubscription.findById(subscription._id).populate("planId");
  const usage = await getUsageSummary(vendorId);
  const plan = populatedSubscription.planId || {};
  const featureUsage = await getFeatureUsageSummary(vendorId, plan);

  return {
    subscription: populatedSubscription,
    plan,
    usage,
    featureUsage,
    remainingToday: Math.max(Number(plan.emailsPerDay || 0) - usage.emailsSentToday, 0),
    remainingThisMonth: Math.max(Number(plan.emailsPerMonth || 0) - usage.emailsSentThisMonth, 0),
  };
};

const assertFeatureLimit = async (vendorId, featureKey, requestedCount = 1) => {
  const normalizedVendorId = String(vendorId || "").trim();
  if (!normalizedVendorId) {
    return null;
  }

  const snapshot = await getSubscriptionSnapshot(normalizedVendorId);
  const feature = snapshot?.featureUsage?.[featureKey];

  if (!feature) {
    return snapshot;
  }

  if (feature.used + Number(requestedCount || 1) > feature.limit) {
    const error = new Error(
      `Your ${snapshot.plan?.name || "current plan"} allows ${feature.limit} ${featureKey}. Upgrade your plan to add more.`,
    );
    error.status = 402;
    error.code = "FEATURE_LIMIT_REACHED";
    error.featureKey = featureKey;
    throw error;
  }

  return snapshot;
};

const assertEmailQuota = async (vendorId, requestedCount) => {
  const snapshot = await getSubscriptionSnapshot(vendorId);
  if (!snapshot) {
    return snapshot;
  }

  const { subscription, plan, usage } = snapshot;
  const status = subscription.status || "free";
  const periodEnd = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;

  if (["expired", "cancelled", "payment_failed", "past_due"].includes(status)) {
    const error = new Error("Subscription is not active. Please renew or upgrade the plan.");
    error.status = 402;
    throw error;
  }

  if (periodEnd && periodEnd < new Date() && status !== "free") {
    const error = new Error("Subscription expired. Please renew the plan to send emails.");
    error.status = 402;
    throw error;
  }

  if (usage.emailsSentToday + requestedCount > Number(plan.emailsPerDay || 0)) {
    const error = new Error(`Daily email limit reached for ${plan.name}`);
    error.status = 402;
    throw error;
  }

  if (usage.emailsSentThisMonth + requestedCount > Number(plan.emailsPerMonth || 0)) {
    const error = new Error(`Monthly email limit reached for ${plan.name}`);
    error.status = 402;
    throw error;
  }

  return snapshot;
};

const recordEmailUsage = async ({ vendorId, count, sourceId = "", sourceType = "campaign", metadata = {} }) => {
  if (!vendorId || !count) {
    return null;
  }

  return UsageLedger.create({
    vendorId,
    count,
    sourceId: String(sourceId || ""),
    sourceType,
    type: "email_send",
    occurredAt: new Date(),
    metadata,
  });
};

const createPlanPayload = (payload = {}) => ({
  name: String(payload.name || "").trim(),
  slug: normalizeSlug(payload.slug || payload.name),
  description: String(payload.description || "").trim(),
  currency: String(payload.currency || "INR").trim().toUpperCase(),
  monthlyPrice: Number(payload.monthlyPrice || 0),
  yearlyPrice: Number(payload.yearlyPrice || 0),
  emailsPerDay: Number(payload.emailsPerDay || 0),
  emailsPerMonth: Number(payload.emailsPerMonth || 0),
  features: Array.isArray(payload.features)
    ? payload.features.map(String).map((item) => item.trim()).filter(Boolean)
    : String(payload.features || "")
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
  limits: {
    automations: Number(payload.limits?.automations || payload.automations || 0),
    teamMembers: Number(payload.limits?.teamMembers || payload.teamMembers || 0),
    templates: Number(payload.limits?.templates || payload.templates || 0),
    segments: Number(payload.limits?.segments || payload.segments || 0),
  },
  isActive: payload.isActive !== false,
  isDefault: Boolean(payload.isDefault),
  sortOrder: Number(payload.sortOrder || 0),
});

const createInvoiceNumber = () => {
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  return `EM-${stamp}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
};

const createManualPaymentAndInvoice = async ({
  vendorId,
  subscription,
  plan,
  amount,
  taxAmount = 0,
  billing = {},
}) => {
  const totalAmount = Number(amount || 0) + Number(taxAmount || 0);
  const payment = await BillingPayment.create({
    vendorId,
    subscriptionId: subscription?._id || null,
    planId: plan?._id || null,
    gateway: "manual",
    amount: Number(amount || 0),
    taxAmount: Number(taxAmount || 0),
    totalAmount,
    currency: plan?.currency || "INR",
    status: totalAmount > 0 ? "paid" : "created",
    paidAt: totalAmount > 0 ? new Date() : null,
  });

  const invoice = await BillingInvoice.create({
    vendorId,
    paymentId: payment._id,
    subscriptionId: subscription?._id || null,
    invoiceNumber: createInvoiceNumber(),
    billingName: billing.billingName || "",
    billingEmail: billing.billingEmail || "",
    billingAddress: billing.billingAddress || "",
    gstNumber: billing.gstNumber || "",
    subtotal: Number(amount || 0),
    gstAmount: Number(taxAmount || 0),
    total: totalAmount,
    currency: plan?.currency || "INR",
    status: totalAmount > 0 ? "paid" : "issued",
    issuedAt: new Date(),
  });

  return { payment, invoice };
};

const getRazorpayCredentials = () => {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    const error = new Error("Razorpay credentials are not configured");
    error.status = 500;
    throw error;
  }

  return {
    keyId: env.razorpayKeyId,
    keySecret: env.razorpayKeySecret,
  };
};

const createRazorpayOrder = async ({ amount, currency = "INR", receipt, notes = {} }) => {
  const { keyId, keySecret } = getRazorpayCredentials();
  const authToken = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency,
      receipt,
      notes,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error?.description || "Unable to create Razorpay order");
    error.status = response.status;
    throw error;
  }

  return payload;
};

const verifyRazorpaySignature = ({ orderId, paymentId, signature }) => {
  const { keySecret } = getRazorpayCredentials();
  const expectedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  return expectedSignature === signature;
};

const createInvoiceForPayment = async ({ payment, subscription, billing = {} }) => {
  const existingInvoice = await BillingInvoice.findOne({ paymentId: payment._id });
  if (existingInvoice) {
    return existingInvoice;
  }

  return BillingInvoice.create({
    vendorId: payment.vendorId,
    paymentId: payment._id,
    subscriptionId: subscription?._id || payment.subscriptionId || null,
    invoiceNumber: createInvoiceNumber(),
    billingName: billing.billingName || "",
    billingEmail: billing.billingEmail || "",
    billingAddress: billing.billingAddress || "",
    gstNumber: billing.gstNumber || "",
    subtotal: Number(payment.amount || 0),
    gstAmount: Number(payment.taxAmount || 0),
    total: Number(payment.totalAmount || 0),
    currency: payment.currency || "INR",
    status: "paid",
    issuedAt: new Date(),
  });
};

const createPlanCheckoutOrder = async ({ vendorId, planId, billingCycle = "monthly" }) => {
  const normalizedVendorId = String(vendorId || "").trim();
  const normalizedBillingCycle = billingCycle === "yearly" ? "yearly" : "monthly";

  if (!normalizedVendorId) {
    const error = new Error("Vendor account required");
    error.status = 400;
    throw error;
  }

  const plan = await BillingPlan.findOne({ _id: planId, isActive: true });
  if (!plan) {
    const error = new Error("Plan not found");
    error.status = 404;
    throw error;
  }

  const amount = normalizedBillingCycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
  if (Number(amount || 0) <= 0) {
    const error = new Error("Paid plan amount is required for checkout");
    error.status = 400;
    throw error;
  }

  const subscription = await ensureVendorSubscription(normalizedVendorId);
  const taxAmount = Math.round(Number(amount || 0) * 0.18);
  const totalAmount = Number(amount || 0) + taxAmount;
  const payment = await BillingPayment.create({
    vendorId: normalizedVendorId,
    subscriptionId: subscription?._id || null,
    planId: plan._id,
    gateway: "razorpay",
    amount,
    taxAmount,
    totalAmount,
    currency: plan.currency || "INR",
    status: "created",
    metadata: {
      billingCycle: normalizedBillingCycle,
    },
  });

  const order = await createRazorpayOrder({
    amount: Math.round(totalAmount * 100),
    currency: plan.currency || "INR",
    receipt: `em_${String(payment._id).slice(-18)}`,
    notes: {
      vendorId: normalizedVendorId,
      planId: String(plan._id),
      billingCycle: normalizedBillingCycle,
      paymentId: String(payment._id),
    },
  });

  payment.gatewayOrderId = order.id;
  payment.metadata = {
    ...payment.metadata,
    razorpayOrder: {
      amount: order.amount,
      amountPaid: order.amount_paid,
      amountDue: order.amount_due,
      status: order.status,
    },
  };
  await payment.save();

  return {
    keyId: getRazorpayCredentials().keyId,
    order,
    payment,
    plan,
    subscription,
    billingCycle: normalizedBillingCycle,
  };
};

const verifyPlanCheckoutPayment = async ({
  vendorId,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) => {
  const normalizedVendorId = String(vendorId || "").trim();

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    const error = new Error("Razorpay payment details are required");
    error.status = 400;
    throw error;
  }

  const payment = await BillingPayment.findOne({
    vendorId: normalizedVendorId,
    gateway: "razorpay",
    gatewayOrderId: razorpayOrderId,
  }).populate("planId");

  if (!payment) {
    const error = new Error("Payment order not found");
    error.status = 404;
    throw error;
  }

  if (payment.status === "paid") {
    const subscription = await VendorSubscription.findOne({ vendorId: normalizedVendorId }).populate("planId");
    const invoice = await createInvoiceForPayment({ payment, subscription });
    return { payment, subscription, invoice };
  }

  const isValid = verifyRazorpaySignature({
    orderId: payment.gatewayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
  });

  if (!isValid) {
    payment.status = "failed";
    payment.failureReason = "signature_mismatch";
    payment.gatewayPaymentId = razorpayPaymentId;
    payment.gatewaySignature = razorpaySignature;
    await payment.save();

    const error = new Error("Invalid Razorpay payment signature");
    error.status = 400;
    throw error;
  }

  const plan = payment.planId;
  const billingCycle = payment.metadata?.billingCycle === "yearly" ? "yearly" : "monthly";
  const now = new Date();
  const subscription = await ensureVendorSubscription(normalizedVendorId);

  subscription.planId = plan._id;
  subscription.status = "active";
  subscription.billingCycle = billingCycle;
  subscription.gateway = "razorpay";
  subscription.currentPeriodStart = now;
  subscription.currentPeriodEnd = addPeriod(billingCycle, now);
  subscription.lastPaymentAt = now;
  subscription.lastPaymentStatus = "paid";
  await subscription.save();

  payment.subscriptionId = subscription._id;
  payment.status = "paid";
  payment.gatewayPaymentId = razorpayPaymentId;
  payment.gatewaySignature = razorpaySignature;
  payment.paidAt = now;
  payment.failureReason = "";
  await payment.save();

  const invoice = await createInvoiceForPayment({ payment, subscription });

  return {
    payment,
    subscription: await VendorSubscription.findById(subscription._id).populate("planId"),
    invoice,
  };
};

export {
  addPeriod,
  assertEmailQuota,
  assertFeatureLimit,
  createInvoiceNumber,
  createPlanCheckoutOrder,
  createManualPaymentAndInvoice,
  createPlanPayload,
  createRazorpayOrder,
  ensureDefaultPlans,
  ensureVendorSubscription,
  getFeatureUsageSummary,
  getRazorpayCredentials,
  getSubscriptionSnapshot,
  recordEmailUsage,
  verifyRazorpaySignature,
  verifyPlanCheckoutPayment,
};
