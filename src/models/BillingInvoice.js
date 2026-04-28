import mongoose from "mongoose";

const billingInvoiceSchema = new mongoose.Schema(
  {
    vendorId: { type: String, required: true, trim: true, index: true },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BillingPayment",
      default: null,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VendorSubscription",
      default: null,
      index: true,
    },
    invoiceNumber: { type: String, required: true, unique: true, trim: true },
    billingName: { type: String, trim: true, default: "" },
    billingEmail: { type: String, trim: true, lowercase: true, default: "" },
    billingAddress: { type: String, trim: true, default: "" },
    gstNumber: { type: String, trim: true, uppercase: true, default: "" },
    subtotal: { type: Number, required: true, min: 0 },
    gstAmount: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    status: {
      type: String,
      enum: ["issued", "paid", "void"],
      default: "issued",
      index: true,
    },
    issuedAt: { type: Date, default: Date.now },
    dueAt: { type: Date, default: null },
    pdfUrl: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

const BillingInvoice =
  mongoose.models.BillingInvoice || mongoose.model("BillingInvoice", billingInvoiceSchema);

export default BillingInvoice;
