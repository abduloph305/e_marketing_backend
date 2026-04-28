import mongoose from "mongoose";

export const automationExecutionStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
  "exited",
];

const automationExecutionSchema = new mongoose.Schema(
  {
    vendorId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationWorkflow",
      required: true,
      index: true,
    },
    subscriberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscriber",
      default: null,
      index: true,
    },
    trigger: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: automationExecutionStatuses,
      default: "pending",
      index: true,
    },
    currentStepOrder: {
      type: Number,
      default: -1,
      min: -1,
    },
    scheduledFor: {
      type: Date,
      default: null,
      index: true,
    },
    pausedAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: "",
      trim: true,
    },
    context: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const AutomationExecution =
  mongoose.models.AutomationExecution ||
  mongoose.model("AutomationExecution", automationExecutionSchema);

export default AutomationExecution;
