import mongoose from "mongoose";

export const subscriptionStatuses = [
  "free",
  "trial",
  "active",
  "past_due",
  "expired",
  "cancelled",
  "payment_failed",
];

const vendorSubscriptionSchema = new mongoose.Schema(
  {
    vendorId: { type: String, required: true, trim: true, unique: true, index: true },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BillingPlan",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: subscriptionStatuses,
      default: "free",
      index: true,
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "yearly", "manual"],
      default: "monthly",
    },
    gateway: {
      type: String,
      enum: ["none", "razorpay", "stripe", "manual"],
      default: "none",
    },
    gatewayCustomerId: { type: String, trim: true, default: "" },
    gatewaySubscriptionId: { type: String, trim: true, default: "" },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null, index: true },
    trialEndsAt: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    lastPaymentAt: { type: Date, default: null },
    lastPaymentStatus: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

vendorSubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

const VendorSubscription =
  mongoose.models.VendorSubscription ||
  mongoose.model("VendorSubscription", vendorSubscriptionSchema);

export default VendorSubscription;
