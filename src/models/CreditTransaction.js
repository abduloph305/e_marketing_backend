import mongoose from "mongoose";

export const creditTransactionTypes = [
  "purchase",
  "campaign_reserve",
  "campaign_deduct",
  "campaign_refund",
  "admin_add",
  "admin_deduct",
  "admin_refund",
  "expiry",
];

const creditTransactionSchema = new mongoose.Schema(
  {
    vendorId: { type: String, required: true, trim: true, index: true },
    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CreditWallet",
      required: true,
      index: true,
    },
    type: { type: String, enum: creditTransactionTypes, required: true, index: true },
    credits: { type: Number, required: true },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    balanceBefore: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true, min: 0 },
    reservedBefore: { type: Number, default: 0, min: 0 },
    reservedAfter: { type: Number, default: 0, min: 0 },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null, index: true },
    reason: { type: String, trim: true, default: "" },
    sourceType: { type: String, trim: true, default: "" },
    sourceId: { type: String, trim: true, default: "", index: true },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      default: null,
      index: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BillingPayment",
      default: null,
      index: true,
    },
    gatewayPaymentId: { type: String, trim: true, default: "", index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

creditTransactionSchema.index({ vendorId: 1, createdAt: -1 });
creditTransactionSchema.index({ gatewayPaymentId: 1, type: 1 });

const CreditTransaction =
  mongoose.models.CreditTransaction ||
  mongoose.model("CreditTransaction", creditTransactionSchema);

export default CreditTransaction;
