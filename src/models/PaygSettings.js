import mongoose from "mongoose";

const paygSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true, immutable: true },
    defaultPerEmailPrice: { type: Number, default: 0.08, min: 0 },
    creditExpiryMonths: { type: Number, default: 0, min: 0 },
    lowBalanceWarningThreshold: { type: Number, default: 1000, min: 0 },
    dailySendLimitDefault: { type: Number, default: 10000, min: 0 },
    maxRecipientsPerCampaignDefault: { type: Number, default: 5000, min: 0 },
  },
  { timestamps: true },
);

const PaygSettings =
  mongoose.models.PaygSettings || mongoose.model("PaygSettings", paygSettingsSchema);

export default PaygSettings;
