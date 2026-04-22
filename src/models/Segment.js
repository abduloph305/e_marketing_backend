import mongoose from "mongoose";

const segmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
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
  },
  {
    timestamps: true,
  }
);

const Segment = mongoose.models.Segment || mongoose.model("Segment", segmentSchema);

export default Segment;
