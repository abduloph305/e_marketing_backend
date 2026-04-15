import app from "./src/app.js";
import connectDatabase from "./src/config/db.js";
import { env } from "./src/config/env.js";
import seedAdmin from "./src/scripts/seedAdmin.js";
import { processDueScheduledCampaigns } from "./src/services/campaignDispatchService.js";
import { processDueAutomationExecutions } from "./src/services/automationService.js";

const startServer = async () => {
  await connectDatabase();
  await seedAdmin();

  app.listen(env.port, () => {
    console.log(`Server running on port ${env.port}`);
  });

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

  const runDueAutomationExecutions = async () => {
    try {
      const results = await processDueAutomationExecutions();

      if (results.length) {
        console.log(`Processed ${results.length} automation execution(s)`);
      }
    } catch (error) {
      console.error("Automation processor failed", error);
    }
  };

  await runDueAutomationExecutions();
  setInterval(runDueAutomationExecutions, 60 * 1000);
};

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
