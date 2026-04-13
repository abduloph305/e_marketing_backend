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
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    role: {
      type: String,
      enum: adminRoles,
      default: "super_admin",
    },
  },
  {
    timestamps: true,
  }
);

adminSchema.methods.comparePassword = function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

adminSchema.methods.toSafeObject = function toSafeObject() {
  const role = this.role || "super_admin";
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    role,
    permissions: getPermissionsForRole(role),
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const Admin = mongoose.models.Admin || mongoose.model("Admin", adminSchema);

export default Admin;
