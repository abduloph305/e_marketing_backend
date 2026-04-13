import AutomationExecution from "../models/AutomationExecution.js";
import AutomationLog from "../models/AutomationLog.js";
import AutomationStep from "../models/AutomationStep.js";
import AutomationWorkflow from "../models/AutomationWorkflow.js";

const defaultStepTitles = {
  delay: "Delay",
  condition: "Condition check",
  send_email: "Send email",
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  webhook: "Webhook",
  exit: "Exit workflow",
};

const normalizeWorkflowPayload = (payload = {}) => ({
  name: payload.name?.trim(),
  description: payload.description?.trim() || "",
  trigger: payload.trigger,
  triggerConfig: payload.triggerConfig || {},
  entrySegmentId: payload.entrySegmentId || null,
  status: payload.status || "draft",
  isActive: Boolean(payload.isActive),
});

const normalizeSteps = (steps = []) =>
  steps.map((step, index) => ({
    order: index,
    type: step.type,
    title: step.title?.trim() || defaultStepTitles[step.type] || "Workflow step",
    description: step.description?.trim() || "",
    config: step.config || {},
  }));

const logAutomationEvent = async (
  workflowId,
  eventType,
  message,
  metadata = {},
  options = {}
) =>
  AutomationLog.create({
    workflowId,
    executionId: options.executionId || null,
    level: options.level || "info",
    eventType,
    message,
    metadata,
  });

const replaceWorkflowSteps = async (workflowId, steps = []) => {
  await AutomationStep.deleteMany({ workflowId });

  const normalizedSteps = normalizeSteps(steps);

  if (!normalizedSteps.length) {
    return [];
  }

  return AutomationStep.insertMany(
    normalizedSteps.map((step) => ({
      workflowId,
      ...step,
    }))
  );
};

const buildWorkflowSummary = async (workflow) => {
  if (!workflow) {
    return null;
  }

  const [stepCount, executionStats, lastLog] = await Promise.all([
    AutomationStep.countDocuments({ workflowId: workflow._id }),
    AutomationExecution.aggregate([
      { $match: { workflowId: workflow._id } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),
    AutomationLog.findOne({ workflowId: workflow._id }).sort({ createdAt: -1 }).lean(),
  ]);

  const stats = executionStats.reduce(
    (accumulator, item) => {
      accumulator[item._id] = item.count;
      return accumulator;
    },
    { pending: 0, running: 0, completed: 0, failed: 0, exited: 0 }
  );

  return {
    ...workflow.toObject(),
    stepCount,
    executionStats: stats,
    lastLog,
  };
};

const buildWorkflowDetailPayload = async (workflowId) => {
  const workflow = await AutomationWorkflow.findById(workflowId)
    .populate({ path: "entrySegmentId", select: "name" });

  if (!workflow) {
    return null;
  }

  const [steps, executions, logs] = await Promise.all([
    AutomationStep.find({ workflowId }).sort({ order: 1 }).lean(),
    AutomationExecution.find({ workflowId })
      .populate({ path: "subscriberId", select: "firstName lastName email" })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
    AutomationLog.find({ workflowId }).sort({ createdAt: -1 }).limit(12).lean(),
  ]);

  const summary = await buildWorkflowSummary(workflow);

  return {
    ...summary,
    steps,
    recentExecutions: executions,
    logs,
  };
};

const createWorkflowExecution = async ({ workflowId, subscriberId = null, trigger, context = {} }) => {
  const execution = await AutomationExecution.create({
    workflowId,
    subscriberId,
    trigger,
    status: "pending",
    context,
  });

  await AutomationWorkflow.findByIdAndUpdate(workflowId, {
    $inc: { executionCount: 1 },
    lastRunAt: new Date(),
  });

  await logAutomationEvent(
    workflowId,
    "execution.created",
    "Workflow execution created",
    { trigger, subscriberId },
    { executionId: execution._id }
  );

  return execution;
};

const processWorkflowExecution = async (executionId) => {
  const execution = await AutomationExecution.findById(executionId);

  if (!execution) {
    return null;
  }

  await AutomationExecution.findByIdAndUpdate(executionId, {
    status: "running",
    startedAt: new Date(),
  });

  const steps = await AutomationStep.find({ workflowId: execution.workflowId }).sort({ order: 1 });

  for (const step of steps) {
    await logAutomationEvent(
      execution.workflowId,
      "step.processed",
      `Processed ${step.type} step`,
      { stepId: step._id, order: step.order, config: step.config },
      { executionId: execution._id }
    );

    if (step.type === "exit") {
      await AutomationExecution.findByIdAndUpdate(executionId, {
        status: "exited",
        currentStepOrder: step.order,
        completedAt: new Date(),
      });

      await logAutomationEvent(
        execution.workflowId,
        "execution.exited",
        "Execution exited workflow",
        { stepId: step._id },
        { executionId: execution._id }
      );

      return { status: "exited" };
    }
  }

  await AutomationExecution.findByIdAndUpdate(executionId, {
    status: "completed",
    currentStepOrder: steps.length ? steps[steps.length - 1].order : 0,
    completedAt: new Date(),
  });

  await logAutomationEvent(
    execution.workflowId,
    "execution.completed",
    "Workflow execution completed",
    {},
    { executionId: execution._id }
  );

  return { status: "completed" };
};

const registerEcommerceAutomationHooks = () => ({
  supportedTriggers: [
    "abandoned_cart",
    "browse_abandonment",
    "order_followup",
    "review_request",
    "price_drop",
    "back_in_stock",
  ],
  state: "future_ready",
  message:
    "These hooks are scaffolded for future ecommerce event ingestion without coupling this dashboard to a store yet.",
});

export {
  normalizeWorkflowPayload,
  normalizeSteps,
  logAutomationEvent,
  replaceWorkflowSteps,
  buildWorkflowSummary,
  buildWorkflowDetailPayload,
  createWorkflowExecution,
  processWorkflowExecution,
  registerEcommerceAutomationHooks,
};
