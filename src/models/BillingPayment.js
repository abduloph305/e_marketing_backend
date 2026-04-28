import mongoose from "mongoose";

const billingPaymentSchema = new mongoose.Schema(
  {
    vendorId: { type: String, required: true, trim: true, index: true },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VendorSubscription",
      default: null,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BillingPlan",
      default: null,
      index: true,
    },
    gateway: {
      type: String,
      enum: ["razorpay", "stripe", "manual"],
      default: "manual",
      index: true,
    },
    gatewayOrderId: { type: String, trim: true, default: "" },
    gatewayPaymentId: { type: String, trim: true, default: "" },
    gatewaySignature: { type: String, trim: true, default: "" },
    amount: { type: Number, required: true, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    status: {
      type: String,
      enum: ["created", "paid", "failed", "refunded", "cancelled"],
      default: "created",
      index: true,
    },
    paidAt: { type: Date, default: null },
    failureReason: { type: String, trim: true, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true },
);

billingPaymentSchema.index({ vendorId: 1, createdAt: -1 });

const BillingPayment =
  mongoose.models.BillingPayment || mongoose.model("BillingPayment", billingPaymentSchema);

export default BillingPayment;
