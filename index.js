import app from "./src/app.js";
import connectDatabase from "./src/config/db.js";
import { env } from "./src/config/env.js";
import seedAdmin from "./src/scripts/seedAdmin.js";
import { processDueScheduledCampaigns } from "./src/services/campaignDispatchService.js";
import { processDueAutomationExecutions } from "./src/services/automationService.js";

const CAMPAIGN_SCHEDULER_INTERVAL_MS = 15 * 1000;
const AUTOMATION_SCHEDULER_INTERVAL_MS = 60 * 1000;

const startServer = async () => {
  await connectDatabase();
  await seedAdmin();

  app.listen(env.port, () => {
    console.log(`Server running on port ${env.port}`);
  });

  let campaignSchedulerRunning = false;

  const runScheduledCampaigns = async () => {
    if (campaignSchedulerRunning) {
      console.log("[scheduler:campaigns] previous run still in progress, skipping tick");
      return;
    }

    campaignSchedulerRunning = true;

    try {
      console.log("[scheduler:campaigns] checking for due campaigns");
      const results = await processDueScheduledCampaigns();

      if (results.length) {
        console.log(`[scheduler:campaigns] processed ${results.length} due campaign(s)`);
      } else {
        console.log("[scheduler:campaigns] no due campaigns found");
      }
    } catch (error) {
      console.error("[scheduler:campaigns] processor failed", error);
    } finally {
      campaignSchedulerRunning = false;
    }
  };

  console.log(
    `[scheduler:campaigns] started, polling every ${CAMPAIGN_SCHEDULER_INTERVAL_MS / 1000}s`,
  );
  await runScheduledCampaigns();
  setInterval(runScheduledCampaigns, CAMPAIGN_SCHEDULER_INTERVAL_MS);

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
  setInterval(runDueAutomationExecutions, AUTOMATION_SCHEDULER_INTERVAL_MS);
};

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
