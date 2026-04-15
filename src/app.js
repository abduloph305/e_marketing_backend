import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/authRoutes.js";
import automationRoutes from "./routes/automationRoutes.js";
import campaignRoutes from "./routes/campaignRoutes.js";
import emailRoutes from "./routes/emailRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import integrationRoutes from "./routes/integrationRoutes.js";
import subscriberRoutes from "./routes/subscriberRoutes.js";
import segmentRoutes from "./routes/segmentRoutes.js";
import templateRoutes from "./routes/templateRoutes.js";
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

app.get("/api", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRoutes);
app.use("/api/automations", automationRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/subscribers", subscriberRoutes);
app.use("/api/segments", segmentRoutes);

app.use((req, res) => {
  res.status(404).json({ message: `Route not found: ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: "Internal server error" });
});

export default app;

