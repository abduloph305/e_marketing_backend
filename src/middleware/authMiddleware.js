import jwt from "jsonwebtoken";
import Admin from "../models/Admin.js";
import { env } from "../config/env.js";
import { hasPermission } from "../config/roles.js";

const protectAdmin = async (req, res, next) => {
  try {
    const bearerToken = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.split(" ")[1]
      : null;
    const token = req.cookies?.token || bearerToken;

    if (!token) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const decoded = jwt.verify(token, env.jwtSecret);
    const admin = await Admin.findById(decoded.id);

    if (!admin) {
      return res.status(401).json({ message: "Admin not found" });
    }

    req.admin = admin;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

const permitRoles = (...roles) => (req, res, next) => {
  if (!req.admin) {
    return res.status(401).json({ message: "Authentication required" });
  }

  if (!roles.includes(req.admin.role || "super_admin")) {
    return res.status(403).json({ message: "Insufficient role access" });
  }

  return next();
};

const requirePermission = (permission) => (req, res, next) => {
  if (!req.admin) {
    return res.status(401).json({ message: "Authentication required" });
  }

  if (!hasPermission(req.admin.role || "super_admin", permission)) {
    return res.status(403).json({ message: "Insufficient permission" });
  }

  return next();
};

export { protectAdmin, permitRoles, requirePermission };
