import mongoose from "mongoose";

const segmentSchema = new mongoose.Schema(
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
      trim: true,
      default: "",
    },
    definition: {
      type: mongoose.Schema.Types.Mixed,
      default: { logic: "and", filters: [] },
    },
    rules: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    websiteScope: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({
        websiteId: "",
        websiteSlug: "",
        websiteName: "",
        label: "",
      }),
    },
  },
  {
    timestamps: true,
  }
);

segmentSchema.index({ vendorId: 1, name: 1 }, { unique: true });

const Segment = mongoose.models.Segment || mongoose.model("Segment", segmentSchema);

export default Segment;
