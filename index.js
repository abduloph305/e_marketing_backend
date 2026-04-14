import app from "./src/app.js";
import connectDatabase from "./src/config/db.js";
import { env } from "./src/config/env.js";
import seedAdmin from "./src/scripts/seedAdmin.js";
import { processDueScheduledCampaigns } from "./src/services/campaignDispatchService.js";
import cors from "cors";

const startServer = async () => {
  await connectDatabase();
  await seedAdmin();

  app.listen(env.port, () => {
    console.log(`Server running on port ${env.port}`);
  });



app.use(cors({
  origin: "https://e-marketing-frontend.vercel.app",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

  const runScheduledCampaigns = async () => {
    try {
      const results = await processDueScheduledCampaigns();

      if (results.length) {
        console.log(`Processed ${results.length} scheduled campaign(s)`);
      }
    } catch (error) {
      console.error("Scheduled campaign processor failed", error);
    }
  };

  await runScheduledCampaigns();
  setInterval(runScheduledCampaigns, 60 * 1000);
};

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
