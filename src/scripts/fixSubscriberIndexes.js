import mongoose from "mongoose";
import { env } from "../config/env.js";
import Subscriber from "../models/Subscriber.js";

const fixSubscriberIndexes = async () => {
  await mongoose.connect(env.mongoUri);

  const collection = Subscriber.collection;
  const indexes = await collection.indexes();
  const legacyEmailIndex = indexes.find(
    (index) =>
      index.name === "email_1" &&
      index.unique === true &&
      JSON.stringify(index.key) === JSON.stringify({ email: 1 }),
  );

  if (legacyEmailIndex) {
    await collection.dropIndex(legacyEmailIndex.name);
    console.log("Dropped legacy unique index:", legacyEmailIndex.name);
  } else {
    console.log("Legacy unique email index not found.");
  }

  await collection.createIndex(
    { vendorId: 1, email: 1 },
    {
      name: "vendorId_1_email_1",
      unique: true,
    },
  );
  console.log("Ensured vendor-scoped unique index: vendorId_1_email_1");

  await mongoose.disconnect();
};

fixSubscriberIndexes().catch(async (error) => {
  console.error("Unable to fix subscriber indexes:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
