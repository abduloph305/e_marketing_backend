import mongoose from "mongoose";

const emailTemplateSchema = new mongoose.Schema(
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
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    previewText: {
      type: String,
      default: "",
      trim: true,
    },
    htmlContent: {
      type: String,
      required: true,
    },
    designJson: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

emailTemplateSchema.index({ vendorId: 1, name: 1 }, { unique: true });

const EmailTemplate =
  mongoose.models.EmailTemplate ||
  mongoose.model("EmailTemplate", emailTemplateSchema);

export default EmailTemplate;
