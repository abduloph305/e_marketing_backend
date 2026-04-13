import mongoose from "mongoose";

const segmentRuleSchema = new mongoose.Schema(
  {
    field: {
      type: String,
      required: true,
      trim: true,
    },
    operator: {
      type: String,
      required: true,
      trim: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    _id: false,
  }
);

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
    rules: {
      type: [segmentRuleSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const Segment = mongoose.models.Segment || mongoose.model("Segment", segmentSchema);

export default Segment;
