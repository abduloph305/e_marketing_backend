import express from "express";
import {
  activateWorkflow,
  createSampleExecution,
  createWorkflow,
  deactivateWorkflow,
  deleteWorkflow,
  getAutomationMeta,
  getWorkflowById,
  getWorkflowExecutions,
  listWorkflows,
  triggerWorkflows,
  updateWorkflow,
} from "../controllers/automationController.js";
import { protectAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protectAdmin);

router.get("/meta", getAutomationMeta);
router.get("/", listWorkflows);
router.get("/:id", getWorkflowById);
router.get("/:id/executions", getWorkflowExecutions);
router.post("/", createWorkflow);
router.post("/:id/activate", activateWorkflow);
router.post("/:id/deactivate", deactivateWorkflow);
router.post("/:id/sample-execution", createSampleExecution);
router.post("/trigger", triggerWorkflows);
router.put("/:id", updateWorkflow);
router.delete("/:id", deleteWorkflow);

export default router;
