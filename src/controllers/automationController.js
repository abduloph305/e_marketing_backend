import Segment from "../models/Segment.js";
import EmailTemplate from "../models/EmailTemplate.js";
import AutomationExecution, {
  automationExecutionStatuses,
} from "../models/AutomationExecution.js";
import AutomationLog from "../models/AutomationLog.js";
import AutomationStep, { automationStepTypes } from "../models/AutomationStep.js";
import AutomationWorkflow, {
  automationTriggers,
  automationWorkflowStatuses,
} from "../models/AutomationWorkflow.js";
import {
  buildWorkflowDetailPayload,
  buildWorkflowSummary,
  createWorkflowExecution,
  logAutomationEvent,
  normalizeSteps,
  normalizeWorkflowPayload,
  processWorkflowExecution,
  registerEcommerceAutomationHooks,
  replaceWorkflowSteps,
} from "../services/automationService.js";

const buildWorkflowMatch = (query) => {
  const match = {};

  if (query.status && query.status !== "all") {
    match.status = query.status;
  }

  if (query.trigger) {
    match.trigger = query.trigger;
  }

  if (query.search?.trim()) {
    const pattern = new RegExp(
      query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    );
    match.$or = [{ name: pattern }, { description: pattern }];
  }

  return match;
};

const validateWorkflowPayload = (payload) => {
  if (!payload.name?.trim()) {
    return "Workflow name is required";
  }

  if (!payload.trigger) {
    return "Workflow trigger is required";
  }

  const steps = normalizeSteps(payload.steps || []);

  if (!steps.length) {
    return "At least one workflow step is required";
  }

  return "";
};

const getAutomationMeta = async (_req, res) => {
  const [templates, segments] = await Promise.all([
    EmailTemplate.find().select("name subject").sort({ updatedAt: -1 }),
    Segment.find().select("name").sort({ updatedAt: -1 }),
  ]);

  return res.json({
    triggers: automationTriggers,
    statuses: automationWorkflowStatuses,
    stepTypes: automationStepTypes,
    executionStatuses: automationExecutionStatuses,
    templates,
    segments,
    ecommerceHooks: registerEcommerceAutomationHooks(),
  });
};

const listWorkflows = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const match = buildWorkflowMatch(req.query);

  const [workflows, total] = await Promise.all([
    AutomationWorkflow.find(match)
      .populate({ path: "entrySegmentId", select: "name" })
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AutomationWorkflow.countDocuments(match),
  ]);

  const rows = await Promise.all(workflows.map((workflow) => buildWorkflowSummary(workflow)));

  return res.json({
    data: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
};

const getWorkflowById = async (req, res) => {
  const payload = await buildWorkflowDetailPayload(req.params.id);

  if (!payload) {
    return res.status(404).json({ message: "Workflow not found" });
  }

  return res.json(payload);
};

const createWorkflow = async (req, res) => {
  const validationError = validateWorkflowPayload(req.body);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  try {
    const workflow = await AutomationWorkflow.create(normalizeWorkflowPayload(req.body));
    await replaceWorkflowSteps(workflow._id, req.body.steps || []);
    await logAutomationEvent(workflow._id, "workflow.created", "Workflow created", {
      trigger: workflow.trigger,
      stepCount: (req.body.steps || []).length,
    });

    const payload = await buildWorkflowDetailPayload(workflow._id);
    return res.status(201).json(payload);
  } catch (_error) {
    return res.status(400).json({ message: "Unable to create workflow" });
  }
};

const updateWorkflow = async (req, res) => {
  const validationError = validateWorkflowPayload(req.body);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  try {
    const workflow = await AutomationWorkflow.findByIdAndUpdate(
      req.params.id,
      normalizeWorkflowPayload(req.body),
      { returnDocument: "after", runValidators: true }
    );

    if (!workflow) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    await replaceWorkflowSteps(workflow._id, req.body.steps || []);
    await logAutomationEvent(workflow._id, "workflow.updated", "Workflow updated", {
      trigger: workflow.trigger,
      stepCount: (req.body.steps || []).length,
    });

    const payload = await buildWorkflowDetailPayload(workflow._id);
    return res.json(payload);
  } catch (_error) {
    return res.status(400).json({ message: "Unable to update workflow" });
  }
};

const activateWorkflow = async (req, res) => {
  const workflow = await AutomationWorkflow.findByIdAndUpdate(
    req.params.id,
    {
      status: "active",
      isActive: true,
      activatedAt: new Date(),
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!workflow) {
    return res.status(404).json({ message: "Workflow not found" });
  }

  await logAutomationEvent(workflow._id, "workflow.activated", "Workflow activated");
  const payload = await buildWorkflowDetailPayload(workflow._id);
  return res.json(payload);
};

const deactivateWorkflow = async (req, res) => {
  const workflow = await AutomationWorkflow.findByIdAndUpdate(
    req.params.id,
    {
      status: "inactive",
      isActive: false,
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!workflow) {
    return res.status(404).json({ message: "Workflow not found" });
  }

  await logAutomationEvent(workflow._id, "workflow.deactivated", "Workflow deactivated");
  const payload = await buildWorkflowDetailPayload(workflow._id);
  return res.json(payload);
};

const getWorkflowExecutions = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);

  const [executions, total] = await Promise.all([
    AutomationExecution.find({ workflowId: req.params.id })
      .populate({ path: "subscriberId", select: "firstName lastName email" })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AutomationExecution.countDocuments({ workflowId: req.params.id }),
  ]);

  return res.json({
    data: executions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
};

const createSampleExecution = async (req, res) => {
  const workflow = await AutomationWorkflow.findById(req.params.id);

  if (!workflow) {
    return res.status(404).json({ message: "Workflow not found" });
  }

  const execution = await createWorkflowExecution({
    workflowId: workflow._id,
    trigger: workflow.trigger,
    context: {
      source: "manual_preview",
      notes: "Created from the dashboard to validate workflow structure.",
    },
  });

  await processWorkflowExecution(execution._id);

  return res.json({ message: "Sample execution processed" });
};

const deleteWorkflow = async (req, res) => {
  const workflow = await AutomationWorkflow.findByIdAndDelete(req.params.id);

  if (!workflow) {
    return res.status(404).json({ message: "Workflow not found" });
  }

  await Promise.all([
    AutomationStep.deleteMany({ workflowId: req.params.id }),
    AutomationExecution.deleteMany({ workflowId: req.params.id }),
    AutomationLog.deleteMany({ workflowId: req.params.id }),
  ]);

  return res.json({ message: "Workflow deleted" });
};

export {
  getAutomationMeta,
  listWorkflows,
  getWorkflowById,
  createWorkflow,
  updateWorkflow,
  activateWorkflow,
  deactivateWorkflow,
  getWorkflowExecutions,
  createSampleExecution,
  deleteWorkflow,
};
