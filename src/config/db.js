import mongoose from "mongoose";
import { env } from "./env.js";

const connectDatabase = async () => {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.mongoUri);
  console.log("MongoDB connected");
};

export default connectDatabase;
