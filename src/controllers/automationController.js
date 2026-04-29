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
import { env } from "../config/env.js";
import { isValidObjectId } from "mongoose";
import {
  buildWorkflowDetailPayload,
  buildWorkflowSummary,
  logAutomationEvent,
  normalizeSteps,
  normalizeWorkflowPayload,
  triggerWorkflowExecutions,
  registerEcommerceAutomationHooks,
  replaceWorkflowSteps,
} from "../services/automationService.js";
import { notifyVendorActivity } from "../services/adminNotificationService.js";
import { assertFeatureLimit } from "../services/billingService.js";
import { buildAutomationEmailPayload, sendAutomationEmail } from "../services/sesService.js";
import { buildVendorMatch, getRequestVendorId, withVendorScope, withVendorWrite } from "../utils/vendorScope.js";

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

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

const getAutomationMeta = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const [templates, segments] = await Promise.all([
    EmailTemplate.find(vendorMatch).select("name subject").sort({ updatedAt: -1 }),
    Segment.find(vendorMatch).select("name websiteScope").sort({ updatedAt: -1 }),
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
  const match = withVendorScope(req, buildWorkflowMatch(req.query));

  const [workflows, total] = await Promise.all([
    AutomationWorkflow.find(match)
      .populate({ path: "entrySegmentId", select: "name websiteScope" })
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
  const payload = await buildWorkflowDetailPayload(req.params.id, buildVendorMatch(req));

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
    await assertFeatureLimit(getRequestVendorId(req), "automations");
    const workflow = await AutomationWorkflow.create(withVendorWrite(req, normalizeWorkflowPayload(req.body)));
    await replaceWorkflowSteps(workflow._id, req.body.steps || []);
    await logAutomationEvent(workflow._id, "workflow.created", "Workflow created", {
      trigger: workflow.trigger,
      stepCount: (req.body.steps || []).length,
    });
    await notifyVendorActivity({
      actor: req.admin,
      entityType: "automation",
      entityId: workflow._id,
      action: "created",
      title: "Automation created",
      itemName: workflow.name,
    });

    const payload = await buildWorkflowDetailPayload(workflow._id, buildVendorMatch(req));
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
    const vendorMatch = buildVendorMatch(req);
    const workflow = await AutomationWorkflow.findOneAndUpdate(
      { _id: req.params.id, ...vendorMatch },
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
    await notifyVendorActivity({
      actor: req.admin,
      entityType: "automation",
      entityId: workflow._id,
      action: "updated",
      title: "Automation updated",
      itemName: workflow.name,
    });

    const payload = await buildWorkflowDetailPayload(workflow._id, vendorMatch);
    return res.json(payload);
  } catch (_error) {
    return res.status(400).json({ message: "Unable to update workflow" });
  }
};

const activateWorkflow = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const workflow = await AutomationWorkflow.findOneAndUpdate(
    { _id: req.params.id, ...vendorMatch },
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
  await notifyVendorActivity({
    actor: req.admin,
    entityType: "automation",
    entityId: workflow._id,
    action: "activated",
    title: "Automation activated",
    itemName: workflow.name,
  });
  const payload = await buildWorkflowDetailPayload(workflow._id, vendorMatch);
  return res.json(payload);
};

const deactivateWorkflow = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const workflow = await AutomationWorkflow.findOneAndUpdate(
    { _id: req.params.id, ...vendorMatch },
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
  await notifyVendorActivity({
    actor: req.admin,
    entityType: "automation",
    entityId: workflow._id,
    action: "deactivated",
    title: "Automation deactivated",
    itemName: workflow.name,
  });
  const payload = await buildWorkflowDetailPayload(workflow._id, vendorMatch);
  return res.json(payload);
};

const getWorkflowExecutions = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);

  const [executions, total] = await Promise.all([
    AutomationExecution.find({ workflowId: req.params.id, ...buildVendorMatch(req) })
      .populate({ path: "subscriberId", select: "firstName lastName email" })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AutomationExecution.countDocuments({ workflowId: req.params.id, ...buildVendorMatch(req) }),
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

const previewWorkflowEmail = async (req, res) => {
  const workflowId = req.body.workflowId || req.params.id || null;
  const workflowPayload = req.body.workflow || null;
  const recipientEmail = String(req.body.recipientEmail || req.body.email || env.adminEmail || "preview@example.com")
    .trim()
    .toLowerCase();
  const previewFirstName = String(req.body.firstName || "Preview").trim() || "Preview";
  const previewLastName = String(req.body.lastName || "Recipient").trim() || "Recipient";

  let workflow = workflowPayload;

  if (workflowId) {
    const loadedWorkflow = await buildWorkflowDetailPayload(workflowId, buildVendorMatch(req));

    if (!loadedWorkflow) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    workflow = workflowPayload
      ? { ...loadedWorkflow, ...workflowPayload, steps: workflowPayload.steps || loadedWorkflow.steps || [] }
      : loadedWorkflow;
  }

  if (!workflow) {
    return res.status(400).json({ message: "Workflow data is required" });
  }

  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const emailStep = steps.find((step) => step.type === "send_email") || null;
  const templateId = emailStep?.config?.templateId || "";
    const template = templateId
      ? await EmailTemplate.findOne({ _id: templateId, ...buildVendorMatch(req) }).lean()
      : null;
  const hasRenderableTemplate = Boolean(template?.htmlContent);

  try {
    const recipient = {
      email: recipientEmail,
      firstName: previewFirstName,
      lastName: previewLastName,
      customFields: {},
    };

    const payload = hasRenderableTemplate
      ? buildAutomationEmailPayload({
          template,
          recipient,
          subject: emailStep?.config?.subjectOverride?.trim() || template.subject,
          previewText: template.previewText || workflow.description || workflow.name,
        })
      : null;

    const fallbackTitle = workflow.name || "Untitled workflow";
    const fallbackDescription = workflow.description || "This workflow is ready for trigger-based execution.";
    const fallbackSubject = emailStep?.config?.subjectOverride?.trim() || template?.subject || fallbackTitle;
    const fallbackTemplateName = template?.name || emailStep?.title || "No template selected";
    const fallbackPreviewText = template?.previewText || fallbackDescription || fallbackTitle;

    const fallbackHtml = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;">
    <div style="max-width:760px;margin:0 auto;padding:24px;">
      <div style="border:1px solid #e5e7eb;border-radius:24px;background:#fff;padding:24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#94a3b8;">Automation preview</div>
        <h1 style="margin:10px 0 0;font-size:34px;line-height:1.15;color:#0f172a;">${escapeHtml(fallbackTitle)}</h1>
        <p style="margin:14px 0 0;font-size:16px;line-height:1.8;color:#475467;">${escapeHtml(fallbackDescription)}</p>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;">
          <span style="border:1px solid #e5e7eb;border-radius:999px;background:#f8fafc;padding:7px 12px;font-size:12px;font-weight:700;color:#475467;">Recipient: ${escapeHtml(recipient.email)}</span>
          <span style="border:1px solid #e5e7eb;border-radius:999px;background:#f8fafc;padding:7px 12px;font-size:12px;font-weight:700;color:#475467;">${escapeHtml(fallbackTemplateName)}</span>
        </div>
      </div>
    </div>
  </body>
</html>`;

    return res.json({
      workflowId: workflowId || null,
      workflowName: fallbackTitle,
      trigger: workflow.trigger || "",
      templateId,
      templateName: fallbackTemplateName,
      stepTitle: emailStep?.title || "Send email",
      stepType: emailStep?.type || "send_email",
      recipientEmail,
      subject: hasRenderableTemplate ? payload.Content?.Simple?.Subject?.Data || template.subject || "" : fallbackSubject,
      html: hasRenderableTemplate ? payload.Content?.Simple?.Body?.Html?.Data || "" : fallbackHtml,
      text: hasRenderableTemplate ? payload.Content?.Simple?.Body?.Text?.Data || "" : fallbackPreviewText,
      previewText: fallbackPreviewText,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unable to render workflow preview" });
  }
};

const parseEmailList = (value) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [value])
        .flatMap((entry) => String(entry || "").split(/[\n,]+/))
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

const createSampleExecution = async (req, res) => {
  const workflowPayload = req.body.workflow || null;
  const workflowId = req.params.id || req.body.workflowId || null;
  let workflow = workflowPayload;

  if (!workflow && workflowId) {
    const loadedWorkflow = await buildWorkflowDetailPayload(workflowId, buildVendorMatch(req));

    if (!loadedWorkflow) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    workflow = workflowPayload
      ? { ...loadedWorkflow, ...workflowPayload, steps: workflowPayload.steps || loadedWorkflow.steps || [] }
      : loadedWorkflow;
  }

  if (!workflow) {
    return res.status(400).json({ message: "Workflow data is required" });
  }

  try {
    const recipientEmails = parseEmailList(
      req.body.emails || req.body.recipientEmail || req.body.email || env.adminEmail || "preview@example.com",
    );
    const steps = Array.isArray(workflow.steps) && workflow.steps.length
      ? workflow.steps
      : workflowId && isValidObjectId(workflowId)
        ? await AutomationStep.find({ workflowId, ...buildVendorMatch(req) }).sort({ order: 1 }).lean()
        : [];
    const emailStep = steps.find((step) => step.type === "send_email") || null;

    if (!emailStep?.config?.templateId) {
      return res.status(400).json({ message: "Send email step requires a template" });
    }

    const template = await EmailTemplate.findOne({
      _id: emailStep.config.templateId,
      ...buildVendorMatch(req),
    }).lean();

    if (!template) {
      return res.status(404).json({ message: "Selected email template not found" });
    }

    const results = [];

    for (const recipientEmail of recipientEmails) {
      const { messageId } = await sendAutomationEmail({
        template,
        recipient: {
          email: recipientEmail,
          firstName: "Preview",
          lastName: "Recipient",
        },
        subject: emailStep.config.subjectOverride?.trim() || template.subject,
        previewText: template.previewText || workflow.description || workflow.name,
      });

      results.push({ recipientEmail, messageId });
    }

    return res.json({ message: "Test email sent", count: results.length, results });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unable to process sample execution" });
  }
};

const triggerWorkflows = async (req, res) => {
  const trigger = req.body.trigger?.trim();

  if (!trigger) {
    return res.status(400).json({ message: "Trigger is required" });
  }

  try {
    const results = await triggerWorkflowExecutions({
      trigger,
      subscriberId: req.body.subscriberId || null,
      context: req.body.context || {},
    });

    return res.json({
      message: "Workflow trigger processed",
      results,
      matchedCount: results.length,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Unable to trigger workflows" });
  }
};

const deleteWorkflow = async (req, res) => {
  const vendorMatch = buildVendorMatch(req);
  const workflow = await AutomationWorkflow.findOneAndDelete({ _id: req.params.id, ...vendorMatch });

  if (!workflow) {
    return res.status(404).json({ message: "Workflow not found" });
  }

  await Promise.all([
    AutomationStep.deleteMany({ workflowId: req.params.id, ...vendorMatch }),
    AutomationExecution.deleteMany({ workflowId: req.params.id, ...vendorMatch }),
    AutomationLog.deleteMany({ workflowId: req.params.id, ...vendorMatch }),
  ]);

  await notifyVendorActivity({
    actor: req.admin,
    entityType: "automation",
    entityId: workflow._id,
    action: "deleted",
    title: "Automation deleted",
    itemName: workflow.name,
  });

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
  previewWorkflowEmail,
  createSampleExecution,
  deleteWorkflow,
  triggerWorkflows,
};
