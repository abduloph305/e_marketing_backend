import mongoose from "mongoose";

const userActivityLogSchema = new mongoose.Schema(
  {
    vendorId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    actorAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
      index: true,
    },
    actorName: {
      type: String,
      trim: true,
      default: "",
    },
    actorEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    module: {
      type: String,
      trim: true,
      default: "activity",
      index: true,
    },
    action: {
      type: String,
      trim: true,
      default: "recorded",
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
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
    entityName: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      trim: true,
      default: "completed",
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ipAddress: {
      type: String,
      trim: true,
      default: "",
    },
    userAgent: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
  },
);

userActivityLogSchema.index({ vendorId: 1, createdAt: -1 });
userActivityLogSchema.index({ module: 1, action: 1, createdAt: -1 });
userActivityLogSchema.index({ actorEmail: 1, createdAt: -1 });

const UserActivityLog =
  mongoose.models.UserActivityLog ||
  mongoose.model("UserActivityLog", userActivityLogSchema);

export default UserActivityLog;
