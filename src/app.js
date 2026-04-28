import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import authRoutes from "./routes/authRoutes.js";
import adminDashboardRoutes from "./routes/adminDashboardRoutes.js";
import adminNotificationRoutes from "./routes/adminNotificationRoutes.js";
import automationRoutes from "./routes/automationRoutes.js";
import billingRoutes from "./routes/billingRoutes.js";
import campaignRoutes from "./routes/campaignRoutes.js";
import emailRoutes from "./routes/emailRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import integrationRoutes from "./routes/integrationRoutes.js";
import teamRoutes from "./routes/teamRoutes.js";
import subscriberRoutes from "./routes/subscriberRoutes.js";
import segmentRoutes from "./routes/segmentRoutes.js";
import templateRoutes from "./routes/templateRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import { env } from "./config/env.js";

const app = express();

const allowedOrigins = new Set([
  "http://localhost:5173",
  "https://e-marketing-frontend.vercel.app",
  ...env.clientUrls,
]);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
  }),
);

app.use(express.json());
app.use(cookieParser());
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

app.get("/api", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin-dashboard", adminDashboardRoutes);
app.use("/api/admin-notifications", adminNotificationRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/automations", automationRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/team-users", teamRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/subscribers", subscriberRoutes);
app.use("/api/segments", segmentRoutes);
app.use("/api/uploads", uploadRoutes);

app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: "Internal server error" });
});

export default app;

