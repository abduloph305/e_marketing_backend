import mongoose from "mongoose";

export const suppressionReasons = [
  "unsubscribe",
  "manual",
  "bounce",
  "complaint",
  "reject",
];

export const suppressionStatuses = ["active", "released"];

const suppressionEntrySchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    reason: {
      type: String,
      enum: suppressionReasons,
      required: true,
    },
    source: {
      type: String,
      default: "admin",
      trim: true,
    },
    status: {
      type: String,
      enum: suppressionStatuses,
      default: "active",
    },
    relatedCampaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      default: null,
    },
    relatedSubscriberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscriber",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

suppressionEntrySchema.index({ email: 1, status: 1 });
suppressionEntrySchema.index({ reason: 1, status: 1 });

const SuppressionEntry =
  mongoose.models.SuppressionEntry ||
  mongoose.model("SuppressionEntry", suppressionEntrySchema);

export default SuppressionEntry;
