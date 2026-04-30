import AutomationExecution from "../models/AutomationExecution.js";
import AutomationLog from "../models/AutomationLog.js";
import AutomationStep from "../models/AutomationStep.js";
import AutomationWorkflow from "../models/AutomationWorkflow.js";
import EmailTemplate from "../models/EmailTemplate.js";
import Segment from "../models/Segment.js";
import Subscriber from "../models/Subscriber.js";
import { buildSegmentQuery, normalizeSegmentDefinition } from "../utils/segmentEngine.js";
import {
  buildWebsiteScopeMatch,
  combineAudienceMatches,
  normalizeWebsiteScope,
} from "../utils/audienceWebsiteScope.js";
import { isSubscriberEligibleForEmail } from "../utils/emailEligibility.js";
import { recordEmailUsage } from "./billingService.js";
import {
  deductReservedCredits,
  refundReservedCredits,
  reserveCredits,
} from "./paygBillingService.js";
import { sendAutomationEmail } from "./sesService.js";

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
  websiteScope: normalizeWebsiteScope(payload.websiteScope || {}),
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
) => {
  const workflow = await AutomationWorkflow.findById(workflowId).select("vendorId").lean();

  return AutomationLog.create({
    vendorId: workflow?.vendorId || "",
    workflowId,
    executionId: options.executionId || null,
    level: options.level || "info",
    eventType,
    message,
    metadata,
  });
};

const replaceWorkflowSteps = async (workflowId, steps = []) => {
  const workflow = await AutomationWorkflow.findById(workflowId).select("vendorId").lean();
  const vendorMatch = workflow?.vendorId ? { vendorId: workflow.vendorId } : {};

  await AutomationStep.deleteMany({ workflowId, ...vendorMatch });

  const normalizedSteps = normalizeSteps(steps);

  if (!normalizedSteps.length) {
    return [];
  }

  return AutomationStep.insertMany(
    normalizedSteps.map((step) => ({
      ...vendorMatch,
      workflowId,
      ...step,
    }))
  );
};

const buildWorkflowSummary = async (workflow) => {
  if (!workflow) {
    return null;
  }

  const vendorMatch = workflow.vendorId ? { vendorId: workflow.vendorId } : {};
  const [stepCount, executionStats, lastLog] = await Promise.all([
    AutomationStep.countDocuments({ workflowId: workflow._id, ...vendorMatch }),
    AutomationExecution.aggregate([
      { $match: { workflowId: workflow._id, ...vendorMatch } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]),
    AutomationLog.findOne({ workflowId: workflow._id, ...vendorMatch }).sort({ createdAt: -1 }).lean(),
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

const buildWorkflowDetailPayload = async (workflowId, scopeMatch = {}) => {
  const workflow = await AutomationWorkflow.findOne({ _id: workflowId, ...scopeMatch }).populate({
    path: "entrySegmentId",
    select: "name definition rules websiteScope",
  });

  if (!workflow) {
    return null;
  }

  const vendorMatch = workflow.vendorId ? { vendorId: workflow.vendorId } : {};
  const [steps, executions, logs] = await Promise.all([
    AutomationStep.find({ workflowId, ...vendorMatch }).sort({ order: 1 }).lean(),
    AutomationExecution.find({ workflowId, ...vendorMatch })
      .populate({ path: "subscriberId", select: "firstName lastName email status tags engagementScore" })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
    AutomationLog.find({ workflowId, ...vendorMatch }).sort({ createdAt: -1 }).limit(12).lean(),
  ]);

  const summary = await buildWorkflowSummary(workflow);

  return {
    ...summary,
    steps,
    recentExecutions: executions,
    logs,
  };
};

const getNestedValue = (object, path) => {
  if (!object || !path) {
    return undefined;
  }

  return String(path)
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), object);
};

const toComparableString = (value) => {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
};

const evaluateConditionStep = (step, subscriber) => {
  const config = step.config || {};
  const field = config.field;
  const operator = config.operator || "eq";
  const expectedValue = config.value;

  if (!field) {
    return false;
  }

  const actualValue = getNestedValue(subscriber, field);

  if (operator === "contains") {
    return toComparableString(actualValue)
      .toLowerCase()
      .includes(toComparableString(expectedValue).toLowerCase());
  }

  if (operator === "in") {
    const values = Array.isArray(expectedValue)
      ? expectedValue
      : String(expectedValue || "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);

    return values.some((entry) => toComparableString(actualValue).toLowerCase() === entry.toLowerCase());
  }

  if (operator === "gte" || operator === "lte") {
    const actualNumber = Number(actualValue);
    const expectedNumber = Number(expectedValue);

    if (Number.isNaN(actualNumber) || Number.isNaN(expectedNumber)) {
      return false;
    }

    return operator === "gte"
      ? actualNumber >= expectedNumber
      : actualNumber <= expectedNumber;
  }

  return toComparableString(actualValue).toLowerCase() ===
    toComparableString(expectedValue).toLowerCase();
};

const getDelayMilliseconds = (config = {}) => {
  const value = Number(config.value || 0);

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const unit = String(config.unit || "hours").toLowerCase();

  switch (unit) {
    case "minutes":
      return value * 60 * 1000;
    case "days":
      return value * 24 * 60 * 60 * 1000;
    case "hours":
    default:
      return value * 60 * 60 * 1000;
  }
};

const subscriberMatchesWorkflow = async (workflow, subscriber) => {
  if (!subscriber?._id) {
    return false;
  }

  const segment = workflow.entrySegmentId
    ? await Segment.findById(workflow.entrySegmentId).select("definition rules websiteScope").lean()
    : null;

  if (workflow.entrySegmentId && !segment) {
    return false;
  }

  const definition = normalizeSegmentDefinition(segment?.definition || { rules: segment?.rules || [] });
  const match = combineAudienceMatches(
    buildWebsiteScopeMatch(workflow.websiteScope || {}),
    buildWebsiteScopeMatch(segment?.websiteScope || {}),
    definition.filters.length ? buildSegmentQuery(definition) : {},
  );
  const matchedSubscriber = await Subscriber.findOne({
    _id: subscriber._id,
    ...match,
  })
    .select("_id")
    .lean();

  return Boolean(matchedSubscriber);
};

const buildAutomationRecipient = (subscriber) => ({
  email: subscriber.email,
  firstName: subscriber.firstName,
  lastName: subscriber.lastName,
  subscriberId: subscriber._id,
  customFields: subscriber.customFields || {},
  fullName: [subscriber.firstName, subscriber.lastName].filter(Boolean).join(" ").trim(),
});

const buildPreviewSubscriber = (context = {}) => ({
  _id: null,
  email: context.previewRecipientEmail || "preview@example.com",
  firstName: context.previewFirstName || "Preview",
  lastName: context.previewLastName || "Recipient",
  status: "subscribed",
  tags: [],
  engagementScore: 0,
  totalOrders: 0,
  totalSpent: 0,
  lastOpenAt: null,
  lastClickAt: null,
  lastOrderDate: null,
  lastEmailSentAt: null,
  lastActivityAt: null,
});

const applySendEmailStep = async ({ step, workflow, subscriber, execution }) => {
  const templateId = step.config?.templateId;

  if (!templateId) {
    throw new Error("Send email step requires a template");
  }

  const template = await EmailTemplate.findById(templateId).lean();

  if (!template) {
    throw new Error("Selected email template not found");
  }

  if (!isSubscriberEligibleForEmail(subscriber)) {
    throw new Error(`Subscriber ${subscriber.email} is not eligible to receive email`);
  }

  const subject = step.config?.subjectOverride?.trim() || template.subject;
  const shouldBillSend = Boolean(workflow.vendorId) && execution.context?.source !== "manual_preview";

  if (shouldBillSend) {
    await reserveCredits({
      vendorId: workflow.vendorId,
      credits: 1,
      sourceType: "automation",
      sourceId: execution._id,
    });
  }

  let messageId = "";
  try {
    const result = await sendAutomationEmail({
      template,
      recipient: buildAutomationRecipient(subscriber),
      subject,
      previewText: template.previewText || workflow.description || workflow.name,
    });
    messageId = result.messageId;
  } catch (error) {
    if (shouldBillSend) {
      await refundReservedCredits({
        vendorId: workflow.vendorId,
        credits: 1,
        sourceType: "automation",
        sourceId: execution._id,
        metadata: { stepId: step._id, failedBeforeSend: true },
      });
    }
    throw error;
  }

  if (shouldBillSend) {
    await deductReservedCredits({
      vendorId: workflow.vendorId,
      credits: 1,
      sourceType: "automation",
      sourceId: execution._id,
      metadata: { stepId: step._id, templateId },
    });
    await recordEmailUsage({
      vendorId: workflow.vendorId,
      count: 1,
      sourceId: execution._id,
      sourceType: "automation",
      metadata: { workflowId: workflow._id, stepId: step._id },
    });
  }

  await Subscriber.findByIdAndUpdate(subscriber._id, {
    lastEmailSentAt: new Date(),
    lastActivityAt: new Date(),
  });

  await logAutomationEvent(
    workflow._id,
    "step.email_sent",
    `Automation email sent to ${subscriber.email}`,
    {
      stepId: step._id,
      messageId,
      subject,
      templateId,
    },
    { executionId: execution._id }
  );

  return { messageId };
};

const applyTagStep = async ({ step, workflow, subscriber, execution, action }) => {
  const tag = step.config?.tag?.trim();

  if (!tag) {
    throw new Error(`${step.type} step requires a tag name`);
  }

  const update =
    action === "add"
      ? { $addToSet: { tags: tag } }
      : { $pull: { tags: tag } };

  await Subscriber.findByIdAndUpdate(subscriber._id, {
    ...update,
    $set: {
      lastActivityAt: new Date(),
    },
  });

  await logAutomationEvent(
    workflow._id,
    action === "add" ? "step.tag_added" : "step.tag_removed",
    `${action === "add" ? "Added" : "Removed"} tag "${tag}" for ${subscriber.email}`,
    {
      stepId: step._id,
      tag,
    },
    { executionId: execution._id }
  );
};

const applyWebhookStep = async ({ step, workflow, subscriber, execution }) => {
  const url = step.config?.url?.trim();

  if (!url) {
    throw new Error("Webhook step requires a URL");
  }

  const method = String(step.config?.method || "POST").toUpperCase();
  const payload = {
    workflow: {
      id: String(workflow._id),
      name: workflow.name,
      trigger: workflow.trigger,
    },
    execution: {
      id: String(execution._id),
      status: execution.status,
      currentStepOrder: execution.currentStepOrder,
    },
    subscriber: subscriber
      ? {
          id: String(subscriber._id),
          email: subscriber.email,
          firstName: subscriber.firstName,
          lastName: subscriber.lastName,
          status: subscriber.status,
          tags: subscriber.tags || [],
          engagementScore: subscriber.engagementScore || 0,
        }
      : null,
    step: {
      id: String(step._id),
      type: step.type,
      title: step.title,
      config: step.config || {},
    },
  };

  const response = await fetch(url, {
    method,
    headers:
      method === "GET"
        ? undefined
        : {
            "Content-Type": "application/json",
          },
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook request failed with status ${response.status}`);
  }

  await logAutomationEvent(
    workflow._id,
    "step.webhook_sent",
    `Webhook invoked for ${subscriber?.email || "workflow execution"}`,
    {
      stepId: step._id,
      url,
      method,
      responseStatus: response.status,
    },
    { executionId: execution._id }
  );
};

const buildExecutionFailureMessage = (error) => error?.message || "Workflow execution failed";

const createWorkflowExecution = async ({
  workflowId,
  subscriberId = null,
  trigger,
  context = {},
}) => {
  const workflow = await AutomationWorkflow.findById(workflowId).select("vendorId").lean();
  const vendorId = workflow?.vendorId || "";
  const execution = await AutomationExecution.create({
    vendorId,
    workflowId,
    subscriberId,
    trigger,
    status: "pending",
    currentStepOrder: -1,
    context,
    scheduledFor: null,
    pausedAt: null,
    lastError: "",
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

  if (execution.status === "running") {
    return { status: "running" };
  }

  if (execution.scheduledFor && execution.scheduledFor > new Date()) {
    return { status: "pending", scheduledFor: execution.scheduledFor };
  }

  await AutomationExecution.findByIdAndUpdate(executionId, {
    status: "running",
    startedAt: execution.startedAt || new Date(),
    scheduledFor: null,
    pausedAt: null,
    lastError: "",
  });

  const workflow = await AutomationWorkflow.findById(execution.workflowId);

  if (!workflow) {
    await AutomationExecution.findByIdAndUpdate(executionId, {
      status: "failed",
      completedAt: new Date(),
      lastError: "Workflow not found",
    });
    return { status: "failed" };
  }

  const subscriber = execution.subscriberId
    ? await Subscriber.findById(execution.subscriberId).lean()
    : null;
  const effectiveSubscriber =
    subscriber ||
    (execution.context?.source === "manual_preview" ? buildPreviewSubscriber(execution.context) : null);

  const steps = await AutomationStep.find({ workflowId: execution.workflowId }).sort({ order: 1 });
  const currentStepOrder = Number(execution.currentStepOrder);
  const startIndex = Math.max(Number.isFinite(currentStepOrder) ? currentStepOrder + 1 : 0, 0);

  try {
    for (let index = startIndex; index < steps.length; index += 1) {
      const step = steps[index];

      await logAutomationEvent(
        workflow._id,
        "step.processed",
        `Processing ${step.type} step`,
        { stepId: step._id, order: step.order, config: step.config },
        { executionId: execution._id }
      );

      if (step.type === "delay") {
        const delayMs = getDelayMilliseconds(step.config || {});

        if (delayMs > 0) {
          const scheduledFor = new Date(Date.now() + delayMs);

          await AutomationExecution.findByIdAndUpdate(executionId, {
            status: "pending",
            currentStepOrder: step.order,
            scheduledFor,
            pausedAt: new Date(),
          });

          await logAutomationEvent(
            workflow._id,
            "execution.paused",
            `Workflow paused until ${scheduledFor.toISOString()}`,
            { stepId: step._id, scheduledFor },
            { executionId: execution._id }
          );

          return { status: "paused", scheduledFor };
        }
      } else if (step.type === "condition") {
        const passed = evaluateConditionStep(step, effectiveSubscriber || {});

        if (!passed) {
          await AutomationExecution.findByIdAndUpdate(executionId, {
            status: "exited",
            currentStepOrder: step.order,
            completedAt: new Date(),
          });

          await logAutomationEvent(
            workflow._id,
            "execution.exited",
            "Execution stopped because the condition did not match",
            { stepId: step._id },
            { executionId: execution._id }
          );

          return { status: "exited" };
        }
      } else if (step.type === "send_email") {
        if (!effectiveSubscriber?.email) {
          throw new Error("Send email step requires a subscriber email");
        }

        await applySendEmailStep({
          step,
          workflow,
          subscriber: effectiveSubscriber,
          execution,
        });
      } else if (step.type === "add_tag") {
        if (!subscriber) {
          if (execution.context?.source === "manual_preview") {
            await logAutomationEvent(
              workflow._id,
              "step.skipped",
              "Add tag step skipped for preview execution",
              { stepId: step._id },
              { executionId: execution._id }
            );
            continue;
          }

          throw new Error("Add tag step requires a subscriber");
        }

        await applyTagStep({
          step,
          workflow,
          subscriber,
          execution,
          action: "add",
        });
      } else if (step.type === "remove_tag") {
        if (!subscriber) {
          if (execution.context?.source === "manual_preview") {
            await logAutomationEvent(
              workflow._id,
              "step.skipped",
              "Remove tag step skipped for preview execution",
              { stepId: step._id },
              { executionId: execution._id }
            );
            continue;
          }

          throw new Error("Remove tag step requires a subscriber");
        }

        await applyTagStep({
          step,
          workflow,
          subscriber,
          execution,
          action: "remove",
        });
      } else if (step.type === "webhook") {
        await applyWebhookStep({
          step,
          workflow,
          subscriber: effectiveSubscriber,
          execution,
        });
      } else if (step.type === "exit") {
        await AutomationExecution.findByIdAndUpdate(executionId, {
          status: "exited",
          currentStepOrder: step.order,
          completedAt: new Date(),
        });

        await logAutomationEvent(
          workflow._id,
          "execution.exited",
          "Execution exited workflow",
          { stepId: step._id },
          { executionId: execution._id }
        );

        return { status: "exited" };
      }

      await AutomationExecution.findByIdAndUpdate(executionId, {
        currentStepOrder: step.order,
      });
    }

    await AutomationExecution.findByIdAndUpdate(executionId, {
      status: "completed",
      currentStepOrder: steps.length ? steps[steps.length - 1].order : execution.currentStepOrder,
      completedAt: new Date(),
    });

    await logAutomationEvent(
      workflow._id,
      "execution.completed",
      "Workflow execution completed",
      {},
      { executionId: execution._id }
    );

    return { status: "completed" };
  } catch (error) {
    await AutomationExecution.findByIdAndUpdate(executionId, {
      status: "failed",
      completedAt: new Date(),
      lastError: buildExecutionFailureMessage(error),
    });

    await logAutomationEvent(
      workflow._id,
      "execution.failed",
      "Workflow execution failed",
      { error: buildExecutionFailureMessage(error) },
      { executionId: execution._id, level: "error" }
    );

    throw error;
  }
};

const processDueAutomationExecutions = async () => {
  const now = new Date();
  const dueExecutions = await AutomationExecution.find({
    status: "pending",
    scheduledFor: { $ne: null, $lte: now },
  })
    .sort({ scheduledFor: 1 })
    .limit(25);

  const results = [];

  for (const execution of dueExecutions) {
    try {
      const result = await processWorkflowExecution(execution._id);
      results.push({
        executionId: String(execution._id),
        status: result?.status || "processed",
      });
    } catch (error) {
      results.push({
        executionId: String(execution._id),
        status: "failed",
        error: error.message,
      });
    }
  }

  return results;
};

const triggerWorkflowExecutions = async ({
  trigger,
  subscriberId = null,
  context = {},
}) => {
  if (!trigger) {
    return [];
  }

  const subscriber = subscriberId
    ? await Subscriber.findById(subscriberId).lean()
    : null;
  const vendorMatch = subscriber?.vendorId ? { vendorId: subscriber.vendorId } : {};

  const workflows = await AutomationWorkflow.find({
    ...vendorMatch,
    trigger,
    status: "active",
    isActive: true,
  }).sort({ updatedAt: -1 });

  if (!workflows.length) {
    return [];
  }

  const results = [];

  for (const workflow of workflows) {
    if (!(await subscriberMatchesWorkflow(workflow, subscriber))) {
      continue;
    }

    const execution = await createWorkflowExecution({
      workflowId: workflow._id,
      subscriberId: subscriber?._id || null,
      trigger,
      context: {
        ...context,
        ...vendorMatch,
        trigger,
      },
    });

    const result = await processWorkflowExecution(execution._id);
    results.push({
      workflowId: String(workflow._id),
      executionId: String(execution._id),
      status: result?.status || "created",
    });
  }

  return results;
};

const triggerWorkflowExecutionsForTriggers = async ({
  triggers = [],
  subscriberId = null,
  context = {},
}) => {
  const uniqueTriggers = Array.from(
    new Set(
      (Array.isArray(triggers) ? triggers : [triggers])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );

  const results = [];

  for (const trigger of uniqueTriggers) {
    const workflowResults = await triggerWorkflowExecutions({
      trigger,
      subscriberId,
      context,
    });

    results.push(...workflowResults);
  }

  return results;
};

const registerEcommerceAutomationHooks = () => ({
  supportedTriggers: [
    "welcome_signup",
    "welcome_series",
    "order_confirmation",
    "payment_success",
    "shipping_update",
    "delivery_confirmation",
    "abandoned_cart",
    "browse_abandonment",
    "order_followup",
    "review_request",
    "win_back",
    "price_drop",
    "back_in_stock",
    "inactive_subscriber",
    "reminder_email",
    "discount_offer",
  ],
  state: "future_ready",
  // message:
  //   "These hooks are scaffolded for future ecommerce event ingestion without coupling this dashboard to a store yet.",
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
  processDueAutomationExecutions,
  triggerWorkflowExecutions,
  triggerWorkflowExecutionsForTriggers,
  registerEcommerceAutomationHooks,
};
