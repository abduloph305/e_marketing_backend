import dotenv from "dotenv";

dotenv.config();

const env = {
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGODB_URI || "",
  jwtSecret: process.env.JWT_SECRET || "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
  clientUrls: (process.env.CLIENT_URLS || process.env.CLIENT_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminRole: process.env.ADMIN_ROLE || "super_admin",
  nodeEnv: process.env.NODE_ENV || "development",
  sesRegion: process.env.AWS_SES_REGION || "",
  sesAccessKeyId: process.env.AWS_SES_ACCESS_KEY_ID || "",
  sesSecretAccessKey: process.env.AWS_SES_SECRET_ACCESS_KEY || "",
  sesConfigurationSet: process.env.AWS_SES_CONFIGURATION_SET || "",
  sesWebhookSecret: process.env.SES_WEBHOOK_SECRET || "",
  publicAppUrl:
    process.env.PUBLIC_APP_URL ||
    process.env.APP_URL ||
    process.env.CLIENT_URL ||
    "http://localhost:8080",
};

const requiredKeys = ["mongoUri", "jwtSecret", "adminEmail", "adminPassword"];

requiredKeys.forEach((key) => {
  if (!env[key]) {
    throw new Error(`Missing required environment variable for ${key}`);
  }
});

export { env };
