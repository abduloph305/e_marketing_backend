import mongoose from "mongoose";

const creditPackSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    credits: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

creditPackSchema.virtual("effectiveRate").get(function effectiveRate() {
  return this.credits ? Number(this.price || 0) / Number(this.credits || 1) : 0;
});

creditPackSchema.set("toJSON", { virtuals: true });
creditPackSchema.set("toObject", { virtuals: true });
creditPackSchema.index({ isActive: 1, sortOrder: 1 });

const CreditPack =
  mongoose.models.CreditPack || mongoose.model("CreditPack", creditPackSchema);

export default CreditPack;
