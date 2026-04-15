import mongoose from "mongoose";

const integrationEventSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      default: "ophmate",
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    sourceEventId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    recipientEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    subscriberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscriber",
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ["received", "processed", "ignored", "failed"],
      default: "received",
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    processedAt: {
      type: Date,
      default: null,
    },
    workflowResults: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ([]),
    },
    errorMessage: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

integrationEventSchema.index(
  { source: 1, sourceEventId: 1 },
  { unique: true, sparse: true },
);

const IntegrationEvent =
  mongoose.models.IntegrationEvent ||
  mongoose.model("IntegrationEvent", integrationEventSchema);

export default IntegrationEvent;
