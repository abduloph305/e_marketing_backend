import mongoose from "mongoose";

const billingPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, trim: true, default: "" },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    monthlyPrice: { type: Number, default: 0, min: 0 },
    yearlyPrice: { type: Number, default: 0, min: 0 },
    emailsPerDay: { type: Number, default: 100, min: 0 },
    emailsPerMonth: { type: Number, default: 3000, min: 0 },
    features: { type: [String], default: [] },
    limits: {
      automations: { type: Number, default: 0, min: 0 },
      teamMembers: { type: Number, default: 1, min: 0 },
      templates: { type: Number, default: 5, min: 0 },
      segments: { type: Number, default: 3, min: 0 },
    },
    isActive: { type: Boolean, default: true, index: true },
    isDefault: { type: Boolean, default: false, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

billingPlanSchema.index({ isActive: 1, sortOrder: 1 });

const BillingPlan =
  mongoose.models.BillingPlan || mongoose.model("BillingPlan", billingPlanSchema);

export default BillingPlan;
