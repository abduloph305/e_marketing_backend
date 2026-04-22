import express from "express";
import fs from "fs";
import path from "path";
import { protectAdmin } from "../middleware/authMiddleware.js";
import { env } from "../config/env.js";

const router = express.Router();

const uploadsDir = path.resolve(process.cwd(), "uploads");

const ensureUploadsDir = () => {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
};

const parseDataUrl = (value = "") => {
  const input = String(value || "");
  const match = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1].toLowerCase(),
    base64: match[2],
  };
};

const mimeToExtension = (mimeType = "") => {
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };

  return map[mimeType.toLowerCase()] || "png";
};

router.use(protectAdmin);

router.post("/image", (req, res) => {
  const { dataUrl, filename = "image" } = req.body || {};
  const parsed = parseDataUrl(dataUrl);

  if (!parsed) {
    return res.status(400).json({ message: "Invalid image data" });
  }

  try {
    ensureUploadsDir();

    const safeBaseName = String(filename || "image")
      .trim()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image";
    const extension = mimeToExtension(parsed.mimeType);
    const fileName = `${safeBaseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
    const filePath = path.join(uploadsDir, fileName);
    const buffer = Buffer.from(parsed.base64, "base64");

    fs.writeFileSync(filePath, buffer);

    const requestBaseUrl = `${req.protocol}://${req.get("host")}`.replace(/\/+$/g, "");
    const baseUrl = String(env.publicAppUrl || "")
      .trim()
      .replace(/\/+$/g, "");
    const shouldUseRequestHost =
      /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(requestBaseUrl);
    const publicBaseUrl = shouldUseRequestHost ? requestBaseUrl : (baseUrl || requestBaseUrl);

    return res.status(201).json({
      url: `${publicBaseUrl}/uploads/${fileName}`,
      mimeType: parsed.mimeType,
      fileName,
    });
  } catch (error) {
    return res.status(500).json({ message: "Unable to upload image" });
  }
});

export default router;
