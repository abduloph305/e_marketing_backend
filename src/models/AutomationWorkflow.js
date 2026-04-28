import mongoose from "mongoose";

export const automationTriggers = [
  "welcome_signup",
  "welcome_series",
  "order_confirmation",
  "payment_success",
  "shipping_update",
  "delivery_confirmation",
  "abandoned_cart",
  "browse_abandonment",
  "order_followup",
  "review_request",
  "win_back",
  "price_drop",
  "back_in_stock",
  "inactive_subscriber",
  "reminder_email",
  "discount_offer",
];

export const automationWorkflowStatuses = ["draft", "active", "inactive", "archived"];

const automationWorkflowSchema = new mongoose.Schema(
  {
    vendorId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    trigger: {
      type: String,
      enum: automationTriggers,
      required: true,
    },
    status: {
      type: String,
      enum: automationWorkflowStatuses,
      default: "draft",
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    triggerConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    entrySegmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Segment",
      default: null,
    },
    executionCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastRunAt: {
      type: Date,
      default: null,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const AutomationWorkflow =
  mongoose.models.AutomationWorkflow ||
  mongoose.model("AutomationWorkflow", automationWorkflowSchema);

export default AutomationWorkflow;
