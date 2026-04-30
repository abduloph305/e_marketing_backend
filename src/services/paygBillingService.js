import BillingInvoice from "../models/BillingInvoice.js";
import BillingPayment from "../models/BillingPayment.js";
import CreditPack from "../models/CreditPack.js";
import CreditTransaction from "../models/CreditTransaction.js";
import CreditWallet from "../models/CreditWallet.js";
import PaygSettings from "../models/PaygSettings.js";
import UsageLedger from "../models/UsageLedger.js";
import {
  createInvoiceNumber,
  createRazorpayOrder,
  getRazorpayCredentials,
  verifyRazorpaySignature,
} from "./billingService.js";

const defaultCreditPacks = [
  { name: "10,000 credits", credits: 10000, price: 799, sortOrder: 1 },
  { name: "50,000 credits", credits: 50000, price: 3499, sortOrder: 2 },
  { name: "100,000 credits", credits: 100000, price: 5999, sortOrder: 3 },
  { name: "500,000 credits", credits: 500000, price: 24999, sortOrder: 4 },
];

const startOfDay = (date = new Date()) => {
  const nextDate = new Date(date);
  nextDate.setHours(0, 0, 0, 0);
  return nextDate;
};

const startOfMonth = (date = new Date()) => new Date(date.getFullYear(), date.getMonth(), 1);

const normalizeCredits = (value) => Math.max(Math.floor(Number(value || 0)), 0);

const ensurePaygSettings = async () =>
  PaygSettings.findOneAndUpdate(
    { key: "global" },
    { $setOnInsert: { key: "global" } },
    { new: true, upsert: true },
  );

const ensureDefaultCreditPacks = async () => {
  for (const pack of defaultCreditPacks) {
    await CreditPack.updateOne(
      { name: pack.name },
      { $setOnInsert: { ...pack, currency: "INR", isActive: true } },
      { upsert: true },
    );
  }

  return CreditPack.find().sort({ sortOrder: 1, credits: 1 });
};

const ensureCreditWallet = async (vendorId) => {
  const normalizedVendorId = String(vendorId || "").trim();
  if (!normalizedVendorId) {
    return null;
  }

  return CreditWallet.findOneAndUpdate(
    { vendorId: normalizedVendorId },
    { $setOnInsert: { vendorId: normalizedVendorId } },
    { new: true, upsert: true },
  );
};

const getDailyUsage = async (vendorId) => {
  const rows = await UsageLedger.aggregate([
    {
      $match: {
        vendorId: String(vendorId || ""),
        type: "email_send",
        occurredAt: { $gte: startOfDay() },
      },
    },
    { $group: { _id: null, total: { $sum: "$count" } } },
  ]);

  return rows[0]?.total || 0;
};

const getMonthlyCreditUsage = async (vendorId) => {
  const rows = await CreditTransaction.aggregate([
    {
      $match: {
        vendorId: String(vendorId || ""),
        type: { $in: ["campaign_deduct", "admin_deduct", "expiry"] },
        createdAt: { $gte: startOfMonth() },
      },
    },
    { $group: { _id: null, total: { $sum: { $abs: "$credits" } } } },
  ]);

  return rows[0]?.total || 0;
};

const getEffectiveWalletControls = async (wallet) => {
  const settings = await ensurePaygSettings();

  return {
    perEmailPrice:
      wallet?.customPerEmailPrice === null || wallet?.customPerEmailPrice === undefined
        ? Number(settings.defaultPerEmailPrice || 0)
        : Number(wallet.customPerEmailPrice || 0),
    dailySendLimit:
      wallet?.customDailySendLimit === null || wallet?.customDailySendLimit === undefined
        ? Number(settings.dailySendLimitDefault || 0)
        : Number(wallet.customDailySendLimit || 0),
    maxRecipientsPerCampaign:
      wallet?.customMaxRecipientsPerCampaign === null ||
      wallet?.customMaxRecipientsPerCampaign === undefined
        ? Number(settings.maxRecipientsPerCampaignDefault || 0)
        : Number(wallet.customMaxRecipientsPerCampaign || 0),
    lowBalanceWarningThreshold: Number(settings.lowBalanceWarningThreshold || 0),
    creditExpiryMonths: Number(settings.creditExpiryMonths || 0),
  };
};

const createCreditTransaction = async ({
  wallet,
  type,
  credits,
  amount = 0,
  currency = "INR",
  balanceBefore,
  balanceAfter,
  reservedBefore,
  reservedAfter,
  adminId = null,
  reason = "",
  sourceType = "",
  sourceId = "",
  campaignId = null,
  paymentId = null,
  gatewayPaymentId = "",
  metadata = {},
  expiresAt = null,
}) =>
  CreditTransaction.create({
    vendorId: wallet.vendorId,
    walletId: wallet._id,
    type,
    credits,
    amount,
    currency,
    balanceBefore,
    balanceAfter,
    reservedBefore,
    reservedAfter,
    adminId,
    reason,
    sourceType,
    sourceId: String(sourceId || ""),
    campaignId,
    paymentId,
    gatewayPaymentId,
    metadata,
    expiresAt,
  });

const getWalletSnapshot = async (vendorId, { recentLimit = 12 } = {}) => {
  const wallet = await ensureCreditWallet(vendorId);
  if (!wallet) {
    return null;
  }

  const [settings, packs, recentTransactions, creditsUsedThisMonth, dailyUsed] = await Promise.all([
    ensurePaygSettings(),
    ensureDefaultCreditPacks(),
    CreditTransaction.find({ vendorId: wallet.vendorId })
      .sort({ createdAt: -1 })
      .limit(recentLimit)
      .populate({ path: "campaignId", select: "name" })
      .lean(),
    getMonthlyCreditUsage(wallet.vendorId),
    getDailyUsage(wallet.vendorId),
  ]);
  const controls = await getEffectiveWalletControls(wallet);

  return {
    wallet,
    settings,
    controls,
    packs: packs.filter((pack) => pack.isActive),
    recentTransactions,
    usage: {
      creditsUsedThisMonth,
      dailyUsed,
      dailyRemaining: Math.max(Number(controls.dailySendLimit || 0) - Number(dailyUsed || 0), 0),
      isLowBalance: Number(wallet.availableCredits || 0) <= Number(settings.lowBalanceWarningThreshold || 0),
    },
  };
};

const assertWalletCanSend = async (vendorId, requestedCount, { sourceType = "campaign" } = {}) => {
  const wallet = await ensureCreditWallet(vendorId);
  const requestedCredits = normalizeCredits(requestedCount);
  if (!wallet || requestedCredits <= 0) {
    return wallet;
  }

  const controls = await getEffectiveWalletControls(wallet);
  if (wallet.isFrozen || wallet.sendingFrozen) {
    const error = new Error("Email sending is frozen for this wallet. Please contact support.");
    error.status = 402;
    error.code = "WALLET_FROZEN";
    throw error;
  }

  if (sourceType === "campaign" && controls.maxRecipientsPerCampaign > 0) {
    if (requestedCredits > controls.maxRecipientsPerCampaign) {
      const error = new Error(
        `Campaign recipient limit is ${controls.maxRecipientsPerCampaign.toLocaleString("en-IN")} recipients.`,
      );
      error.status = 402;
      error.code = "CAMPAIGN_RECIPIENT_LIMIT";
      throw error;
    }
  }

  if (controls.dailySendLimit > 0) {
    const usedToday = await getDailyUsage(wallet.vendorId);
    if (usedToday + requestedCredits > controls.dailySendLimit) {
      const error = new Error(
        `Daily send limit reached. You can send ${Math.max(controls.dailySendLimit - usedToday, 0).toLocaleString(
          "en-IN",
        )} more email(s) today.`,
      );
      error.status = 402;
      error.code = "DAILY_CREDIT_LIMIT";
      throw error;
    }
  }

  if (Number(wallet.availableCredits || 0) < requestedCredits) {
    const error = new Error(
      `Insufficient credits. Required ${requestedCredits.toLocaleString("en-IN")}, available ${Number(
        wallet.availableCredits || 0,
      ).toLocaleString("en-IN")}.`,
    );
    error.status = 402;
    error.code = "INSUFFICIENT_CREDITS";
    throw error;
  }

  return wallet;
};

const reserveCredits = async ({ vendorId, credits, sourceType = "campaign", sourceId = "", campaignId = null }) => {
  const requestedCredits = normalizeCredits(credits);
  if (!vendorId || requestedCredits <= 0) {
    return null;
  }

  await assertWalletCanSend(vendorId, requestedCredits, { sourceType });

  const walletAfter = await CreditWallet.findOneAndUpdate(
    {
      vendorId: String(vendorId),
      isFrozen: false,
      sendingFrozen: false,
      availableCredits: { $gte: requestedCredits },
    },
    {
      $inc: {
        availableCredits: -requestedCredits,
        reservedCredits: requestedCredits,
      },
    },
    { new: true },
  );

  if (!walletAfter) {
    const error = new Error("Insufficient credits. Please buy more email credits before sending.");
    error.status = 402;
    error.code = "INSUFFICIENT_CREDITS";
    throw error;
  }

  await createCreditTransaction({
    wallet: walletAfter,
    type: "campaign_reserve",
    credits: -requestedCredits,
    balanceBefore: Number(walletAfter.availableCredits || 0) + requestedCredits,
    balanceAfter: Number(walletAfter.availableCredits || 0),
    reservedBefore: Math.max(Number(walletAfter.reservedCredits || 0) - requestedCredits, 0),
    reservedAfter: Number(walletAfter.reservedCredits || 0),
    sourceType,
    sourceId,
    campaignId,
  });

  return walletAfter;
};

const deductReservedCredits = async ({
  vendorId,
  credits,
  sourceType = "campaign",
  sourceId = "",
  campaignId = null,
  metadata = {},
}) => {
  const usedCredits = normalizeCredits(credits);
  if (!vendorId || usedCredits <= 0) {
    return null;
  }

  const walletAfter = await CreditWallet.findOneAndUpdate(
    {
      vendorId: String(vendorId),
      reservedCredits: { $gte: usedCredits },
    },
    {
      $inc: {
        reservedCredits: -usedCredits,
        usedCredits,
      },
    },
    { new: true },
  );

  if (!walletAfter) {
    throw new Error("Unable to deduct reserved credits");
  }

  await createCreditTransaction({
    wallet: walletAfter,
    type: "campaign_deduct",
    credits: -usedCredits,
    balanceBefore: Number(walletAfter.availableCredits || 0),
    balanceAfter: Number(walletAfter.availableCredits || 0),
    reservedBefore: Number(walletAfter.reservedCredits || 0) + usedCredits,
    reservedAfter: Number(walletAfter.reservedCredits || 0),
    sourceType,
    sourceId,
    campaignId,
    metadata,
  });

  return walletAfter;
};

const refundReservedCredits = async ({
  vendorId,
  credits,
  sourceType = "campaign",
  sourceId = "",
  campaignId = null,
  metadata = {},
}) => {
  const refundCredits = normalizeCredits(credits);
  if (!vendorId || refundCredits <= 0) {
    return null;
  }

  const walletAfter = await CreditWallet.findOneAndUpdate(
    {
      vendorId: String(vendorId),
      reservedCredits: { $gte: refundCredits },
    },
    {
      $inc: {
        availableCredits: refundCredits,
        reservedCredits: -refundCredits,
      },
    },
    { new: true },
  );

  if (!walletAfter) {
    return null;
  }

  await createCreditTransaction({
    wallet: walletAfter,
    type: "campaign_refund",
    credits: refundCredits,
    balanceBefore: Math.max(Number(walletAfter.availableCredits || 0) - refundCredits, 0),
    balanceAfter: Number(walletAfter.availableCredits || 0),
    reservedBefore: Number(walletAfter.reservedCredits || 0) + refundCredits,
    reservedAfter: Number(walletAfter.reservedCredits || 0),
    sourceType,
    sourceId,
    campaignId,
    metadata,
  });

  return walletAfter;
};

const applyAdminWalletAdjustment = async ({
  vendorId,
  adminId,
  type,
  credits,
  reason = "",
  controls = {},
}) => {
  const wallet = await ensureCreditWallet(vendorId);
  const normalizedCredits = normalizeCredits(credits);
  if (!wallet) {
    const error = new Error("Vendor wallet not found");
    error.status = 404;
    throw error;
  }

  const update = {};
  const inc = {};
  let transactionType = "";
  let signedCredits = normalizedCredits;

  if (type === "add") {
    inc.availableCredits = normalizedCredits;
    transactionType = "admin_add";
  } else if (type === "deduct") {
    if (Number(wallet.availableCredits || 0) < normalizedCredits) {
      const error = new Error("Cannot deduct more credits than the available wallet balance");
      error.status = 400;
      throw error;
    }
    inc.availableCredits = -normalizedCredits;
    inc.usedCredits = normalizedCredits;
    transactionType = "admin_deduct";
    signedCredits = -normalizedCredits;
  } else if (type === "refund") {
    inc.availableCredits = normalizedCredits;
    transactionType = "admin_refund";
  }

  ["customPerEmailPrice", "customDailySendLimit", "customMaxRecipientsPerCampaign", "isFrozen", "sendingFrozen"].forEach(
    (key) => {
      if (controls[key] !== undefined) {
        update[key] = controls[key] === "" ? null : controls[key];
      }
    },
  );

  const before = await CreditWallet.findById(wallet._id);
  const after = await CreditWallet.findByIdAndUpdate(
    wallet._id,
    {
      ...(Object.keys(update).length ? { $set: update } : {}),
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
    },
    { new: true, runValidators: true },
  );

  if (transactionType && normalizedCredits > 0) {
    await createCreditTransaction({
      wallet: after,
      type: transactionType,
      credits: signedCredits,
      balanceBefore: Number(before.availableCredits || 0),
      balanceAfter: Number(after.availableCredits || 0),
      reservedBefore: Number(before.reservedCredits || 0),
      reservedAfter: Number(after.reservedCredits || 0),
      adminId,
      reason,
    });
  }

  return after;
};

const normalizePackPayload = (payload = {}) => ({
  name: String(payload.name || "").trim(),
  credits: normalizeCredits(payload.credits),
  price: Number(payload.price || 0),
  currency: String(payload.currency || "INR").trim().toUpperCase(),
  isActive: payload.isActive !== false,
  sortOrder: Number(payload.sortOrder || 0),
});

const createCreditPackCheckoutOrder = async ({ vendorId, packId }) => {
  const normalizedVendorId = String(vendorId || "").trim();
  if (!normalizedVendorId) {
    const error = new Error("Vendor account required");
    error.status = 400;
    throw error;
  }

  const pack = await CreditPack.findOne({ _id: packId, isActive: true });
  if (!pack) {
    const error = new Error("Credit pack not found");
    error.status = 404;
    throw error;
  }

  const taxAmount = Math.round(Number(pack.price || 0) * 0.18);
  const totalAmount = Number(pack.price || 0) + taxAmount;
  const payment = await BillingPayment.create({
    vendorId: normalizedVendorId,
    gateway: "razorpay",
    amount: Number(pack.price || 0),
    taxAmount,
    totalAmount,
    currency: pack.currency || "INR",
    status: "created",
    metadata: {
      billingMode: "payg_credits",
      packId: String(pack._id),
      packName: pack.name,
      credits: pack.credits,
    },
  });

  const order = await createRazorpayOrder({
    amount: Math.round(totalAmount * 100),
    currency: pack.currency || "INR",
    receipt: `cr_${String(payment._id).slice(-18)}`,
    notes: {
      vendorId: normalizedVendorId,
      packId: String(pack._id),
      paymentId: String(payment._id),
      billingMode: "payg_credits",
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
    pack,
  };
};

const createInvoiceForCreditPayment = async ({ payment }) => {
  const existingInvoice = await BillingInvoice.findOne({ paymentId: payment._id });
  if (existingInvoice) {
    return existingInvoice;
  }

  return BillingInvoice.create({
    vendorId: payment.vendorId,
    paymentId: payment._id,
    subscriptionId: null,
    invoiceNumber: createInvoiceNumber(),
    subtotal: Number(payment.amount || 0),
    gstAmount: Number(payment.taxAmount || 0),
    total: Number(payment.totalAmount || 0),
    currency: payment.currency || "INR",
    status: "paid",
    issuedAt: new Date(),
  });
};

const verifyCreditPackCheckoutPayment = async ({
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
    "metadata.billingMode": "payg_credits",
  });

  if (!payment) {
    const error = new Error("Payment order not found");
    error.status = 404;
    throw error;
  }

  const existingPurchase = await CreditTransaction.findOne({
    type: "purchase",
    gatewayPaymentId: razorpayPaymentId,
  });

  if (payment.status === "paid" || existingPurchase) {
    const invoice = await createInvoiceForCreditPayment({ payment });
    return { payment, invoice, wallet: await ensureCreditWallet(normalizedVendorId) };
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

  const pack = await CreditPack.findById(payment.metadata?.packId);
  if (!pack) {
    const error = new Error("Credit pack not found");
    error.status = 404;
    throw error;
  }

  const now = new Date();
  payment.status = "paid";
  payment.gatewayPaymentId = razorpayPaymentId;
  payment.gatewaySignature = razorpaySignature;
  payment.paidAt = now;
  payment.failureReason = "";
  await payment.save();

  const walletBefore = await ensureCreditWallet(normalizedVendorId);
  const settings = await ensurePaygSettings();
  const expiresAt =
    Number(settings.creditExpiryMonths || 0) > 0
      ? new Date(now.getFullYear(), now.getMonth() + Number(settings.creditExpiryMonths || 0), now.getDate())
      : null;
  const walletAfter = await CreditWallet.findOneAndUpdate(
    { vendorId: normalizedVendorId },
    {
      $inc: { availableCredits: Number(pack.credits || 0) },
      $set: { lastPurchaseAt: now },
    },
    { new: true },
  );

  await createCreditTransaction({
    wallet: walletAfter,
    type: "purchase",
    credits: Number(pack.credits || 0),
    amount: Number(payment.totalAmount || 0),
    currency: payment.currency || "INR",
    balanceBefore: Number(walletBefore.availableCredits || 0),
    balanceAfter: Number(walletAfter.availableCredits || 0),
    reservedBefore: Number(walletBefore.reservedCredits || 0),
    reservedAfter: Number(walletAfter.reservedCredits || 0),
    paymentId: payment._id,
    gatewayPaymentId: razorpayPaymentId,
    metadata: {
      packId: String(pack._id),
      packName: pack.name,
      taxAmount: payment.taxAmount,
    },
    expiresAt,
  });

  const invoice = await createInvoiceForCreditPayment({ payment });
  return { payment, invoice, wallet: walletAfter };
};

const getAdminCreditOverview = async () => {
  const rows = await CreditTransaction.aggregate([
    {
      $group: {
        _id: "$vendorId",
        totalPurchased: {
          $sum: { $cond: [{ $eq: ["$type", "purchase"] }, "$credits", 0] },
        },
        totalAdminAdded: {
          $sum: { $cond: [{ $eq: ["$type", "admin_add"] }, "$credits", 0] },
        },
        totalUsed: {
          $sum: { $cond: [{ $in: ["$type", ["campaign_deduct", "admin_deduct", "expiry"]] }, { $abs: "$credits" }, 0] },
        },
        totalRefunded: {
          $sum: { $cond: [{ $in: ["$type", ["campaign_refund", "admin_refund"]] }, "$credits", 0] },
        },
        failedBeforeSendRefunds: {
          $sum: { $cond: [{ $eq: ["$type", "campaign_refund"] }, "$credits", 0] },
        },
        lastPurchaseDate: {
          $max: { $cond: [{ $eq: ["$type", "purchase"] }, "$createdAt", null] },
        },
      },
    },
  ]);
  const wallets = await CreditWallet.find().sort({ updatedAt: -1 }).lean();
  const rowMap = new Map(rows.map((row) => [row._id, row]));

  return wallets.map((wallet) => ({
    ...wallet,
    totals: rowMap.get(wallet.vendorId) || {},
  }));
};

export {
  applyAdminWalletAdjustment,
  assertWalletCanSend,
  createCreditPackCheckoutOrder,
  deductReservedCredits,
  ensureCreditWallet,
  ensureDefaultCreditPacks,
  ensurePaygSettings,
  getAdminCreditOverview,
  getWalletSnapshot,
  normalizePackPayload,
  refundReservedCredits,
  reserveCredits,
  verifyCreditPackCheckoutPayment,
};
