import mongoose from "mongoose";

const adminNotificationSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      trim: true,
      default: "activity",
      index: true,
    },
    vendorId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    vendorName: {
      type: String,
      trim: true,
      default: "",
    },
    actorAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
      index: true,
    },
    entityType: {
      type: String,
      trim: true,
      default: "",
    },
    entityId: {
      type: String,
      trim: true,
      default: "",
    },
    action: {
      type: String,
      trim: true,
      default: "",
    },
    readAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

adminNotificationSchema.index({ readAt: 1, createdAt: -1 });
adminNotificationSchema.index({ type: 1, createdAt: -1 });

const AdminNotification =
  mongoose.models.AdminNotification ||
  mongoose.model("AdminNotification", adminNotificationSchema);

export default AdminNotification;
