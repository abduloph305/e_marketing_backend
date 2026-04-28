import mongoose from "mongoose";

export const subscriberStatuses = [
  "subscribed",
  "unsubscribed",
  "bounced",
  "blocked",
  "complained",
  "suppressed",
];

export const subscriberSources = [
  "website_signup",
  "checkout",
  "popup",
  "admin_import",
  "lead_magnet",
  "referral",
  "manual",
];

const subscriberSchema = new mongoose.Schema(
  {
    vendorId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      enum: subscriberStatuses,
      default: "subscribed",
    },
    blockedReason: {
      type: String,
      trim: true,
      default: "",
    },
    blockedAt: {
      type: Date,
      default: null,
    },
    source: {
      type: String,
      enum: subscriberSources,
      default: "manual",
    },
    sourceLocation: {
      type: String,
      trim: true,
      default: "manual",
    },
    tags: {
      type: [String],
      default: [],
    },
    city: {
      type: String,
      trim: true,
      default: "",
    },
    state: {
      type: String,
      trim: true,
      default: "",
    },
    country: {
      type: String,
      trim: true,
      default: "",
    },
    totalOrders: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalSpent: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastOrderDate: {
      type: Date,
      default: null,
    },
    lastEmailSentAt: {
      type: Date,
      default: null,
    },
    lastOpenAt: {
      type: Date,
      default: null,
    },
    lastClickAt: {
      type: Date,
      default: null,
    },
    lastActivityAt: {
      type: Date,
      default: null,
    },
    engagementScore: {
      type: Number,
      default: 0,
      min: 0,
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    customFields: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

subscriberSchema.index({
  firstName: "text",
  lastName: "text",
  email: "text",
  city: "text",
  state: "text",
  country: "text",
  source: "text",
  notes: "text",
});

subscriberSchema.index({ status: 1, country: 1 });
subscriberSchema.index({ vendorId: 1, email: 1 }, { unique: true });
subscriberSchema.index({ vendorId: 1, status: 1 });
subscriberSchema.index({ status: 1, state: 1 });
subscriberSchema.index({ status: 1, city: 1 });
subscriberSchema.index({ status: 1, tags: 1 });
subscriberSchema.index({ totalOrders: 1 });
subscriberSchema.index({ totalSpent: 1 });
subscriberSchema.index({ engagementScore: -1 });
subscriberSchema.index({ createdAt: -1 });
subscriberSchema.index({ lastActivityAt: -1 });
subscriberSchema.index({ lastOpenAt: -1 });
subscriberSchema.index({ lastClickAt: -1 });
subscriberSchema.index({ lastOrderDate: -1 });

const Subscriber =
  mongoose.models.Subscriber || mongoose.model("Subscriber", subscriberSchema);

export default Subscriber;
