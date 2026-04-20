import mongoose from "mongoose";

export const subscriberStatuses = [
  "subscribed",
  "unsubscribed",
  "bounced",
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
      unique: true,
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

const Subscriber =
  mongoose.models.Subscriber || mongoose.model("Subscriber", subscriberSchema);

export default Subscriber;
