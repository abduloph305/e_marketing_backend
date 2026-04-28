import mongoose from "mongoose";

const usageLedgerSchema = new mongoose.Schema(
  {
    vendorId: { type: String, required: true, trim: true, index: true },
    type: {
      type: String,
      enum: ["email_send"],
      default: "email_send",
      index: true,
    },
    count: { type: Number, required: true, min: 0 },
    sourceType: { type: String, trim: true, default: "" },
    sourceId: { type: String, trim: true, default: "" },
    occurredAt: { type: Date, default: Date.now, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true },
);

usageLedgerSchema.index({ vendorId: 1, type: 1, occurredAt: -1 });

const UsageLedger =
  mongoose.models.UsageLedger || mongoose.model("UsageLedger", usageLedgerSchema);

export default UsageLedger;
