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
  { messageId: 1, recipientEmail: 1, eventType: 1, timestamp: 1 },
  { unique: true }
);

const EmailEvent =
  mongoose.models.EmailEvent || mongoose.model("EmailEvent", emailEventSchema);

export default EmailEvent;
