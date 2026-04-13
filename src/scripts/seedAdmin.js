import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import connectDatabase from "../config/db.js";
import { env } from "../config/env.js";
import Admin from "../models/Admin.js";

const seedAdmin = async () => {
  await connectDatabase();

  const hashedPassword = await bcrypt.hash(env.adminPassword, 10);

  await Admin.findOneAndUpdate(
    { email: env.adminEmail.toLowerCase() },
    {
      name: "Dashboard Admin",
      email: env.adminEmail.toLowerCase(),
      password: hashedPassword,
      role: env.adminRole,
    },
    {
      upsert: true,
      setDefaultsOnInsert: true,
      returnDocument: "after",
    }
  );

  console.log(`Admin seeded for ${env.adminEmail}`);
  await mongoose.disconnect();
};

seedAdmin().catch((error) => {
  console.error("Failed to seed admin", error);
  process.exit(1);
});
