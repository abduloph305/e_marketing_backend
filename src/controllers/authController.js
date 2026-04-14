import jwt from "jsonwebtoken";
import Admin from "../models/Admin.js";
import { env } from "../config/env.js";

const buildToken = (adminId) =>
  jwt.sign({ id: adminId }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

const setAuthCookie = (res, token) => {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: env.nodeEnv === "production" ? "none" : "lax",
    secure: env.nodeEnv === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

const loginAdmin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const admin = await Admin.findOne({ email: email.toLowerCase() }).select(
    "+password",
  );

  if (!admin) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const isValidPassword = await admin.comparePassword(password);

  if (!isValidPassword) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = buildToken(admin.id);
  setAuthCookie(res, token);

  return res.json({
    message: "Login successful",
    token,
    admin: admin.toSafeObject(),
  });
};

const logoutAdmin = async (_req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: env.nodeEnv === "production" ? "none" : "lax",
    secure: env.nodeEnv === "production",
  });

  return res.json({ message: "Logout successful" });
};

const getCurrentAdmin = async (req, res) => {
  return res.json({ admin: req.admin.toSafeObject() });
};

export { loginAdmin, logoutAdmin, getCurrentAdmin };
