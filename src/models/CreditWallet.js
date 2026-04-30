import mongoose from "mongoose";

const creditWalletSchema = new mongoose.Schema(
  {
    vendorId: { type: String, required: true, unique: true, trim: true, index: true },
    availableCredits: { type: Number, default: 0, min: 0 },
    reservedCredits: { type: Number, default: 0, min: 0 },
    usedCredits: { type: Number, default: 0, min: 0 },
    expiredCredits: { type: Number, default: 0, min: 0 },
    customPerEmailPrice: { type: Number, default: null, min: 0 },
    customDailySendLimit: { type: Number, default: null, min: 0 },
    customMaxRecipientsPerCampaign: { type: Number, default: null, min: 0 },
    isFrozen: { type: Boolean, default: false },
    sendingFrozen: { type: Boolean, default: false },
    lastPurchaseAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const CreditWallet =
  mongoose.models.CreditWallet || mongoose.model("CreditWallet", creditWalletSchema);

export default CreditWallet;
