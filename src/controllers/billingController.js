import Admin from "../models/Admin.js";
import BillingInvoice from "../models/BillingInvoice.js";
import BillingPayment from "../models/BillingPayment.js";
import BillingPlan from "../models/BillingPlan.js";
import VendorSubscription from "../models/VendorSubscription.js";
import {
  addPeriod,
  createManualPaymentAndInvoice,
  createPlanCheckoutOrder,
  createPlanPayload,
  ensureDefaultPlans,
  ensureVendorSubscription,
  getSubscriptionSnapshot,
  verifyPlanCheckoutPayment,
} from "../services/billingService.js";
import {
  buildInvoiceHtml,
  buildInvoicePdf,
  getInvoiceDocumentData,
  sendInvoiceEmail,
} from "../services/invoiceDocumentService.js";
import { getRequestVendorId } from "../utils/vendorScope.js";

const toVendorMap = async () => {
  const vendors = await Admin.find({ role: "vendor" })
    .select("name email businessName sellersloginVendorId accountStatus lastLoginAt")
    .lean();

  return vendors.reduce((acc, vendor) => {
    const key = String(vendor.sellersloginVendorId || vendor._id);
    acc[key] = {
      id: String(vendor._id),
      vendorId: key,
      name: vendor.businessName || vendor.name || vendor.email,
      email: vendor.email,
      accountStatus: vendor.accountStatus || "active",
      lastLoginAt: vendor.lastLoginAt,
    };
    return acc;
  }, {});
};

const listPlans = async (_req, res) => {
  await ensureDefaultPlans();
  const plans = await BillingPlan.find().sort({ sortOrder: 1, monthlyPrice: 1 });
  return res.json({ plans });
};

const createPlan = async (req, res) => {
  const payload = createPlanPayload(req.body);
  if (!payload.name || !payload.slug) {
    return res.status(400).json({ message: "Plan name is required" });
  }

  if (payload.isDefault) {
    await BillingPlan.updateMany({}, { $set: { isDefault: false } });
  }

  const plan = await BillingPlan.create(payload);
  return res.status(201).json({ plan });
};

const updatePlan = async (req, res) => {
  const payload = createPlanPayload(req.body);

  if (payload.isDefault) {
    await BillingPlan.updateMany({ _id: { $ne: req.params.id } }, { $set: { isDefault: false } });
  }

  const plan = await BillingPlan.findByIdAndUpdate(req.params.id, payload, {
    new: true,
    runValidators: true,
  });

  if (!plan) {
    return res.status(404).json({ message: "Plan not found" });
  }

  return res.json({ plan });
};

const listSubscriptions = async (_req, res) => {
  await ensureDefaultPlans();
  const vendorMap = await toVendorMap();
  const vendorIds = Object.keys(vendorMap);
  await Promise.all(vendorIds.map((vendorId) => ensureVendorSubscription(vendorId)));

  const subscriptions = await VendorSubscription.find()
    .populate("planId")
    .sort({ updatedAt: -1 })
    .lean();

  return res.json({
    subscriptions: subscriptions.map((subscription) => ({
      ...subscription,
      vendor: vendorMap[subscription.vendorId] || {
        vendorId: subscription.vendorId,
        name: "Unknown vendor",
        email: "",
      },
    })),
  });
};

const updateSubscription = async (req, res) => {
  const { planId, status = "active", billingCycle = "monthly", gateway = "manual", notes = "" } = req.body || {};
  const subscription = await VendorSubscription.findById(req.params.id);

  if (!subscription) {
    return res.status(404).json({ message: "Subscription not found" });
  }

  const plan = await BillingPlan.findById(planId || subscription.planId);
  if (!plan) {
    return res.status(404).json({ message: "Plan not found" });
  }

  const now = new Date();
  subscription.planId = plan._id;
  subscription.status = status;
  subscription.billingCycle = billingCycle;
  subscription.gateway = gateway;
  subscription.currentPeriodStart = subscription.currentPeriodStart || now;
  subscription.currentPeriodEnd = addPeriod(billingCycle, now);
  subscription.notes = String(notes || "").trim();
  subscription.lastPaymentStatus = status === "active" ? "paid" : subscription.lastPaymentStatus;
  if (status === "active") {
    subscription.lastPaymentAt = now;
  }

  await subscription.save();

  if (gateway === "manual" && status === "active") {
    const amount = billingCycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
    const taxAmount = Math.round(Number(amount || 0) * 0.18);
    const { invoice } = await createManualPaymentAndInvoice({
      vendorId: subscription.vendorId,
      subscription,
      plan,
      amount,
      taxAmount,
    });

    sendInvoiceEmail({ invoiceId: invoice._id, vendorId: subscription.vendorId }).catch((error) => {
      console.error("Invoice email failed", error);
    });
  }

  return res.json({
    subscription: await VendorSubscription.findById(subscription._id).populate("planId"),
  });
};

const listPayments = async (_req, res) => {
  const vendorMap = await toVendorMap();
  const payments = await BillingPayment.find()
    .populate("planId")
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return res.json({
    payments: payments.map((payment) => ({
      ...payment,
      vendor: vendorMap[payment.vendorId] || { vendorId: payment.vendorId, name: "Unknown vendor" },
    })),
  });
};

const listInvoices = async (_req, res) => {
  const vendorMap = await toVendorMap();
  const invoices = await BillingInvoice.find()
    .sort({ issuedAt: -1 })
    .limit(200)
    .lean();

  return res.json({
    invoices: invoices.map((invoice) => ({
      ...invoice,
      vendor: vendorMap[invoice.vendorId] || { vendorId: invoice.vendorId, name: "Unknown vendor" },
    })),
  });
};

const getMySubscription = async (req, res) => {
  const vendorId = getRequestVendorId(req);
  if (!vendorId) {
    return res.status(400).json({ message: "Vendor account required" });
  }

  const snapshot = await getSubscriptionSnapshot(vendorId);
  return res.json(snapshot);
};

const listMyInvoices = async (req, res) => {
  const vendorId = getRequestVendorId(req);
  if (!vendorId) {
    return res.status(400).json({ message: "Vendor account required" });
  }

  const invoices = await BillingInvoice.find({ vendorId }).sort({ issuedAt: -1 }).limit(50).lean();
  return res.json({ invoices });
};

const viewMyInvoice = async (req, res) => {
  const vendorId = getRequestVendorId(req);
  if (!vendorId) {
    return res.status(400).json({ message: "Vendor account required" });
  }

  const data = await getInvoiceDocumentData({ invoiceId: req.params.id, vendorId });
  if (!data) {
    return res.status(404).json({ message: "Invoice not found" });
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(buildInvoiceHtml(data));
};

const downloadMyInvoice = async (req, res) => {
  const vendorId = getRequestVendorId(req);
  if (!vendorId) {
    return res.status(400).json({ message: "Vendor account required" });
  }

  const data = await getInvoiceDocumentData({ invoiceId: req.params.id, vendorId });
  if (!data) {
    return res.status(404).json({ message: "Invoice not found" });
  }

  const pdf = buildInvoicePdf(data);
  const filename = `SellersLogin-${data.invoice.invoiceNumber}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", pdf.length);
  return res.send(pdf);
};

const createRazorpayCheckoutOrder = async (req, res) => {
  try {
    const vendorId = getRequestVendorId(req);
    const { planId, billingCycle = "monthly" } = req.body || {};

    if (!vendorId) {
      return res.status(400).json({ message: "Vendor account required" });
    }

    if (!planId) {
      return res.status(400).json({ message: "Plan is required" });
    }

    const checkout = await createPlanCheckoutOrder({
      vendorId,
      planId,
      billingCycle,
    });

    return res.status(201).json({
      keyId: checkout.keyId,
      order: {
        id: checkout.order.id,
        amount: checkout.order.amount,
        currency: checkout.order.currency,
      },
      payment: {
        id: checkout.payment._id,
        amount: checkout.payment.amount,
        taxAmount: checkout.payment.taxAmount,
        totalAmount: checkout.payment.totalAmount,
        currency: checkout.payment.currency,
      },
      plan: checkout.plan,
      billingCycle: checkout.billingCycle,
      prefill: {
        name: req.admin?.businessName || req.admin?.name || "",
        email: req.admin?.email || "",
        contact: req.admin?.phone || "",
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message || "Unable to create checkout order" });
  }
};

const verifyRazorpayCheckoutPayment = async (req, res) => {
  try {
    const vendorId = getRequestVendorId(req);
    const {
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
    } = req.body || {};

    if (!vendorId) {
      return res.status(400).json({ message: "Vendor account required" });
    }

    const result = await verifyPlanCheckoutPayment({
      vendorId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    sendInvoiceEmail({ invoiceId: result.invoice._id, vendorId }).catch((error) => {
      console.error("Invoice email failed", error);
    });

    return res.json({
      message: "Payment verified and plan activated",
      payment: result.payment,
      subscription: result.subscription,
      invoice: result.invoice,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message || "Unable to verify payment" });
  }
};

export {
  createPlan,
  createRazorpayCheckoutOrder,
  downloadMyInvoice,
  getMySubscription,
  listInvoices,
  listMyInvoices,
  listPayments,
  listPlans,
  listSubscriptions,
  updatePlan,
  updateSubscription,
  verifyRazorpayCheckoutPayment,
  viewMyInvoice,
};
