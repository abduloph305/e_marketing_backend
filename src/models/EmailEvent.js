import mongoose from "mongoose";

export const emailEventTypes = [
  "send",
  "delivery",
  "open",
  "click",
  "bounce",
  "complaint",
  "reject",
  "delivery_delay",
  "rendering_failure",
  "unsubscribe",
];

const emailEventSchema = new mongoose.Schema(
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
      default: null,
      index: true,
    },
    subscriberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscriber",
      default: null,
      index: true,
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    messageId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    eventType: {
      type: String,
      enum: emailEventTypes,
      required: true,
      index: true,
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    bounceType: {
      type: String,
      default: "",
      trim: true,
    },
    bounceSubType: {
      type: String,
      default: "",
      trim: true,
    },
    complaintFeedbackType: {
      type: String,
      default: "",
      trim: true,
    },
    clickedLink: {
      type: String,
      default: "",
      trim: true,
    },
    blockId: {
      type: String,
      default: "",
      trim: true,
    },
    section: {
      type: String,
      default: "",
      trim: true,
    },
    ctaType: {
      type: String,
      default: "",
      trim: true,
    },
    ipAddress: {
      type: String,
      default: "",
      trim: true,
    },
    userAgent: {
      type: String,
      default: "",
      trim: true,
    },
    deviceType: {
      type: String,
      default: "",
      trim: true,
    },
    geo: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

emailEventSchema.index(
  { vendorId: 1, messageId: 1, recipientEmail: 1, eventType: 1, timestamp: 1 },
  { unique: true }
);
emailEventSchema.index({ vendorId: 1, eventType: 1, timestamp: -1 });
emailEventSchema.index({ eventType: 1, timestamp: -1 });
emailEventSchema.index({ subscriberId: 1, eventType: 1, timestamp: -1 });
emailEventSchema.index({ recipientEmail: 1, eventType: 1, timestamp: -1 });
emailEventSchema.index({ deviceType: 1, timestamp: -1 });
emailEventSchema.index({ section: 1, timestamp: -1 });
emailEventSchema.index({ blockId: 1, timestamp: -1 });

const EmailEvent =
  mongoose.models.EmailEvent || mongoose.model("EmailEvent", emailEventSchema);

export default EmailEvent;
