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
      default: 0,
      min: 0,
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
