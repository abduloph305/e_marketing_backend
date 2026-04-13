import mongoose from "mongoose";

export const automationLogLevels = ["info", "warning", "error"];

const automationLogSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationWorkflow",
      required: true,
      index: true,
    },
    executionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationExecution",
      default: null,
      index: true,
    },
    level: {
      type: String,
      enum: automationLogLevels,
      default: "info",
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

const AutomationLog =
  mongoose.models.AutomationLog || mongoose.model("AutomationLog", automationLogSchema);

export default AutomationLog;
