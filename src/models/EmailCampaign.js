import mongoose from "mongoose";

export const campaignTypes = [
  "promotional",
  "newsletter",
  "abandoned_cart",
  "win_back",
  "product_launch",
];

export const campaignGoals = ["clicks", "orders", "revenue", "reactivation"];

export const campaignStatuses = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "paused",
  "failed",
  "archived",
];

const totalsSchema = new mongoose.Schema(
  {
    sent: { type: Number, default: 0, min: 0 },
    delivered: { type: Number, default: 0, min: 0 },
    opens: { type: Number, default: 0, min: 0 },
    uniqueOpens: { type: Number, default: 0, min: 0 },
    clicks: { type: Number, default: 0, min: 0 },
    uniqueClicks: { type: Number, default: 0, min: 0 },
    bounces: { type: Number, default: 0, min: 0 },
    complaints: { type: Number, default: 0, min: 0 },
    unsubscribes: { type: Number, default: 0, min: 0 },
    conversions: { type: Number, default: 0, min: 0 },
    revenue: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const emailCampaignSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: campaignTypes,
      required: true,
    },
    goal: {
      type: String,
      enum: campaignGoals,
      default: "clicks",
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    previewText: {
      type: String,
      default: "",
      trim: true,
    },
    fromName: {
      type: String,
      required: true,
      trim: true,
    },
    fromEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    replyTo: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailTemplate",
      required: true,
    },
    segmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Segment",
      default: null,
    },
    status: {
      type: String,
      enum: campaignStatuses,
      default: "draft",
    },
    scheduledAt: {
      type: Date,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    totalRecipients: {
      type: Number,
      default: 0,
      min: 0,
    },
    totals: {
      type: totalsSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

emailCampaignSchema.virtual("totalSent").get(function totalSent() {
  return this.totals?.sent || 0;
});

emailCampaignSchema.virtual("totalDelivered").get(function totalDelivered() {
  return this.totals?.delivered || 0;
});

emailCampaignSchema.virtual("totalOpened").get(function totalOpened() {
  return this.totals?.opens || 0;
});

emailCampaignSchema.virtual("totalClicked").get(function totalClicked() {
  return this.totals?.clicks || 0;
});

emailCampaignSchema.virtual("totalBounced").get(function totalBounced() {
  return this.totals?.bounces || 0;
});

emailCampaignSchema.virtual("totalComplaints").get(function totalComplaints() {
  return this.totals?.complaints || 0;
});

emailCampaignSchema.set("toJSON", { virtuals: true });
emailCampaignSchema.set("toObject", { virtuals: true });

const EmailCampaign =
  mongoose.models.EmailCampaign ||
  mongoose.model("EmailCampaign", emailCampaignSchema);

export default EmailCampaign;
