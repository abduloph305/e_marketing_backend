import mongoose from "mongoose";

export const campaignRecipientStatuses = [
  "queued",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unsubscribed",
  "converted",
  "delivery_delayed",
  "rendering_failed",
  "rejected",
];

const campaignRecipientSchema = new mongoose.Schema(
  {
    vendorId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      required: true,
      index: true,
    },
    subscriberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscriber",
      default: null,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    messageId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: campaignRecipientStatuses,
      default: "queued",
    },
    sentAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    openedAt: {
      type: Date,
      default: null,
    },
    clickedAt: {
      type: Date,
      default: null,
    },
    bouncedAt: {
      type: Date,
      default: null,
    },
    complainedAt: {
      type: Date,
      default: null,
    },
    unsubscribedAt: {
      type: Date,
      default: null,
    },
    convertedAt: {
      type: Date,
      default: null,
    },
    lastConvertedAt: {
      type: Date,
      default: null,
    },
    lastConversionSourceId: {
      type: String,
      default: "",
      trim: true,
    },
    lastConversionSourceType: {
      type: String,
      default: "",
      trim: true,
    },
    conversionSourceIds: {
      type: [String],
      default: () => [],
    },
    conversionCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    revenueAttributed: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

campaignRecipientSchema.index({ campaignId: 1, email: 1 }, { unique: true });
campaignRecipientSchema.index({ vendorId: 1, email: 1, updatedAt: -1 });
campaignRecipientSchema.index({ campaignId: 1, convertedAt: -1 });
campaignRecipientSchema.index({ email: 1, convertedAt: -1 });

const CampaignRecipient =
  mongoose.models.CampaignRecipient ||
  mongoose.model("CampaignRecipient", campaignRecipientSchema);

export default CampaignRecipient;
