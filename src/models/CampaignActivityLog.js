import mongoose from "mongoose";

const campaignActivityLogSchema = new mongoose.Schema(
  {
    vendorId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      required: true,
      index: true,
    },
    type: {
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
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const CampaignActivityLog =
  mongoose.models.CampaignActivityLog ||
  mongoose.model("CampaignActivityLog", campaignActivityLogSchema);

export default CampaignActivityLog;
