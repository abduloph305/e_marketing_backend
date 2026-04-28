import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { adminRoles, getPermissionsForRole } from "../config/roles.js";

const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    businessName: {
      type: String,
      trim: true,
      default: "",
    },
    sellersloginVendorId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    sellersloginAccountType: {
      type: String,
      trim: true,
      default: "",
    },
    sellersloginActorId: {
      type: String,
      trim: true,
      default: "",
    },
    sellersloginPageAccess: {
      type: [String],
      default: [],
    },
    sellersloginWebsiteAccess: {
      type: [String],
      default: [],
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    role: {
      type: String,
      enum: adminRoles,
      default: "vendor",
    },
    permissions: {
      type: [String],
      default: [],
    },
    accountStatus: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    invitedAt: {
      type: Date,
      default: null,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

adminSchema.pre("save", async function hashPassword() {
  if (!this.isModified("password")) {
    return;
  }

  if (String(this.password || "").startsWith("$2")) {
    return;
  }

  this.password = await bcrypt.hash(this.password, 10);
});

adminSchema.methods.comparePassword = function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

adminSchema.methods.toSafeObject = function toSafeObject() {
  const role = this.role || "super_admin";
  const permissions = Array.isArray(this.permissions) && this.permissions.length
    ? this.permissions
    : getPermissionsForRole(role);
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone || "",
    businessName: this.businessName || "",
    sellersloginVendorId: this.sellersloginVendorId || "",
    sellersloginAccountType: this.sellersloginAccountType || "",
    sellersloginActorId: this.sellersloginActorId || "",
    sellersloginPageAccess: this.sellersloginPageAccess || [],
    sellersloginWebsiteAccess: this.sellersloginWebsiteAccess || [],
    role,
    permissions,
    accountStatus: this.accountStatus || "active",
    invitedAt: this.invitedAt,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const Admin = mongoose.models.Admin || mongoose.model("Admin", adminSchema);

export default Admin;
