import mongoose from "mongoose";

export const automationStepTypes = [
  "delay",
  "condition",
  "send_email",
  "add_tag",
  "remove_tag",
  "webhook",
  "exit",
];

const automationStepSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AutomationWorkflow",
      required: true,
      index: true,
    },
    order: {
      type: Number,
      required: true,
      min: 0,
    },
    type: {
      type: String,
      enum: automationStepTypes,
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

automationStepSchema.index({ workflowId: 1, order: 1 }, { unique: true });

const AutomationStep =
  mongoose.models.AutomationStep ||
  mongoose.model("AutomationStep", automationStepSchema);

export default AutomationStep;
