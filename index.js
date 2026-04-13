import app from "./src/app.js";
import connectDatabase from "./src/config/db.js";
import { env } from "./src/config/env.js";

const startServer = async () => {
  await connectDatabase();

  app.listen(env.port, () => {
    console.log(`Server running on port ${env.port}`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
