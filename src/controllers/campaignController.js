import CampaignRecipient from "../models/CampaignRecipient.js";
import CampaignActivityLog from "../models/CampaignActivityLog.js";
import EmailCampaign, {
  campaignGoals,
  campaignStatuses,
  campaignTypes,
} from "../models/EmailCampaign.js";
import EmailEvent from "../models/EmailEvent.js";
import { buildCampaignDetailPayload, logCampaignActivity } from "../services/campaignService.js";
import {
  dispatchCampaign,
  estimateCampaignRecipientCount,
} from "../services/campaignDispatchService.js";
import { notifyVendorActivity } from "../services/adminNotificationService.js";
import { normalizeRecurrenceInterval, normalizeRecurrenceUnit } from "../utils/campaignRecurrence.js";
import { buildVendorMatch, withVendorScope, withVendorWrite } from "../utils/vendorScope.js";

const campaignPopulate = [
  { path: "templateId", select: "name subject previewText" },
  { path: "segmentId", select: "name" },
];

const parseDateTimeInput = (value) => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  const stringValue = String(value);
  const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  const localMatch = stringValue.match(localDateTimePattern);

  if (localMatch) {
    const [, year, month, day, hours, minutes, seconds = "0", milliseconds = "0"] = localMatch;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
      Number(milliseconds.padEnd(3, "0"))
    );

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(stringValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const buildCampaignWritePayload = (payload, existingCampaign = null) => {
  const scheduledAt = parseDateTimeInput(payload.scheduledAt);
  const requestedStatus = String(payload.status || "").trim();
  const isRecurring = Boolean(payload.isRecurring ?? existingCampaign?.isRecurring);
  const existingScheduledAt = existingCampaign?.scheduledAt
    ? new Date(existingCampaign.scheduledAt)
    : null;
  const scheduledTimeChanged =
    Boolean(scheduledAt) &&
    (!existingScheduledAt || scheduledAt.getTime() !== existingScheduledAt.getTime());
  const shouldBeScheduled =
    isRecurring ||
    (Boolean(scheduledAt) &&
      (!existingCampaign || scheduledTimeChanged || requestedStatus === "scheduled" || existingCampaign.status === "scheduled"));

  const writePayload = {
    name: payload.name?.trim(),
    type: payload.type,
    goal: payload.goal || "clicks",
    subject: payload.subject?.trim(),
    previewText: payload.previewText?.trim() || "",
    fromName: payload.fromName?.trim(),
    fromEmail: payload.fromEmail?.trim().toLowerCase(),
    replyTo: payload.replyTo?.trim().toLowerCase() || "",
    templateId: payload.templateId || null,
    segmentId: payload.segmentId || null,
    status: shouldBeScheduled
      ? "scheduled"
      : requestedStatus || existingCampaign?.status || "draft",
    scheduledAt,
    isRecurring,
    recurrenceInterval: normalizeRecurrenceInterval(payload.recurrenceInterval),
    recurrenceUnit: normalizeRecurrenceUnit(payload.recurrenceUnit),
    recurrenceMaxRuns: Number(payload.recurrenceMaxRuns || 0),
    estimatedCost:
      payload.estimatedCost === undefined ? undefined : Number(payload.estimatedCost || 0),
  };

  if (shouldBeScheduled) {
    writePayload.sentAt = null;
  } else if (payload.sentAt !== undefined) {
    writePayload.sentAt = payload.sentAt || null;
  }

  return writePayload;
};

const buildListMatch = (query) => {
  const match = {};

  if (query.status && query.status !== "all") {
    match.status = query.status;
  }

  if (query.type) {
    match.type = query.type;
  }

  if (query.goal) {
    match.goal = query.goal;
  }

  if (query.recurring === 'true' || query.recurring === '1') {
    match.isRecurring = true;
  } else if (query.recurring === 'false' || query.recurring === '0') {
    match.isRecurring = false;
  }

  if (query.search?.trim()) {
    const pattern = new RegExp(
      query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    );

    match.$or = [{ name: pattern }, { subject: pattern }, { fromEmail: pattern }];
  }

  return match;
};

const normalizeCampaignPayload = (payload) => {
  return buildCampaignWritePayload(payload);
};

const refreshCampaignRecipientEstimate = async (campaignId) => {
  const totalRecipients = await estimateCampaignRecipientCount(campaignId);

  await EmailCampaign.findByIdAndUpdate(campaignId, {
    totalRecipients,
  });

  return totalRecipients;
};

const buildDuplicateCampaignName = async (baseName, scopeMatch = {}) => {
  const escapedName = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existingCopies = await EmailCampaign.countDocuments({
    ...scopeMatch,
    name: new RegExp(`^${escapedName} Copy(?: \\d+)?$`, "i"),
  });

  return existingCopies ? `${baseName} Copy ${existingCopies + 1}` : `${baseName} Copy`;
};

const getCampaignMeta = async (_req, res) => {
  return res.json({
    types: campaignTypes,
    goals: campaignGoals,
    statuses: campaignStatuses,
  });
};

const listCampaigns = async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
  const match = withVendorScope(req, buildListMatch(req.query));

  const [campaigns, total] = await Promise.all([
    EmailCampaign.find(match)
      .populate(campaignPopulate)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    EmailCampaign.countDocuments(match),
  ]);

  return res.json({
    data: campaigns,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
};

const getCampaignById = async (req, res) => {
  const payload = await buildCampaignDetailPayload(req.params.id, buildVendorMatch(req));

  if (!payload) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  return res.json(payload);
};

const createCampaign = async (req, res) => {
  try {
    const campaign = await EmailCampaign.create(withVendorWrite(req, normalizeCampaignPayload(req.body)));
    await refreshCampaignRecipientEstimate(campaign._id);
    await logCampaignActivity(campaign._id, "created", "Campaign created", {
      status: campaign.status,
    });
    await notifyVendorActivity({
      actor: req.admin,
      entityType: "campaign",
      entityId: campaign._id,
      action: "created",
      title: "Campaign created",
      itemName: campaign.name,
    });

    const payload = await buildCampaignDetailPayload(campaign._id, buildVendorMatch(req));
    return res.status(201).json(payload);
  } catch (_error) {
    return res.status(400).json({ message: "Unable to create campaign" });
  }
};

const updateCampaign = async (req, res) => {
  try {
    const scopeMatch = buildVendorMatch(req);
    const existingCampaign = await EmailCampaign.findOne({ _id: req.params.id, ...scopeMatch });

    if (!existingCampaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    const campaign = await EmailCampaign.findOneAndUpdate(
      { _id: req.params.id, ...scopeMatch },
      buildCampaignWritePayload(req.body, existingCampaign),
      {
        returnDocument: "after",
        runValidators: true,
      }
    );

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    await logCampaignActivity(campaign._id, "updated", "Campaign updated", {
      status: campaign.status,
    });
    await notifyVendorActivity({
      actor: req.admin,
      entityType: "campaign",
      entityId: campaign._id,
      action: "updated",
      title: "Campaign updated",
      itemName: campaign.name,
    });

    if (!["sent", "sending"].includes(campaign.status)) {
      await refreshCampaignRecipientEstimate(campaign._id);
    }

    const payload = await buildCampaignDetailPayload(campaign._id, scopeMatch);
    return res.json(payload);
  } catch (_error) {
    return res.status(400).json({ message: "Unable to update campaign" });
  }
};

const deleteCampaign = async (req, res) => {
  const scopeMatch = buildVendorMatch(req);
  const campaign = await EmailCampaign.findOneAndDelete({ _id: req.params.id, ...scopeMatch });

  if (!campaign) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  await Promise.all([
    CampaignRecipient.deleteMany({ campaignId: req.params.id, ...scopeMatch }),
    CampaignActivityLog.deleteMany({ campaignId: req.params.id, ...scopeMatch }),
    EmailEvent.deleteMany({ campaignId: req.params.id, ...scopeMatch }),
  ]);

  await notifyVendorActivity({
    actor: req.admin,
    entityType: "campaign",
    entityId: campaign._id,
    action: "deleted",
    title: "Campaign deleted",
    itemName: campaign.name,
  });

  return res.json({ message: "Campaign deleted" });
};

const duplicateCampaign = async (req, res) => {
  try {
    const scopeMatch = buildVendorMatch(req);
    const existingCampaign = await EmailCampaign.findOne({ _id: req.params.id, ...scopeMatch });

    if (!existingCampaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    const duplicate = await EmailCampaign.create({
      vendorId: existingCampaign.vendorId || "",
      name: await buildDuplicateCampaignName(existingCampaign.name, scopeMatch),
      type: existingCampaign.type,
      goal: existingCampaign.goal,
      subject: existingCampaign.subject,
      previewText: existingCampaign.previewText || "",
      fromName: existingCampaign.fromName,
      fromEmail: existingCampaign.fromEmail,
      replyTo: existingCampaign.replyTo || "",
      templateId: existingCampaign.templateId,
      segmentId: existingCampaign.segmentId || null,
      status: "draft",
      scheduledAt: null,
      sentAt: null,
      totalRecipients: 0,
      estimatedCost: Number(existingCampaign.estimatedCost || 0),
      totals: {
        sent: 0,
        delivered: 0,
        opens: 0,
        uniqueOpens: 0,
        clicks: 0,
        uniqueClicks: 0,
        bounces: 0,
        complaints: 0,
        unsubscribes: 0,
        conversions: 0,
        revenue: 0,
      },
    });

    await logCampaignActivity(
      duplicate._id,
      "duplicated",
      "Campaign duplicated from existing campaign",
      {
        sourceCampaignId: existingCampaign._id,
      }
    );
    await notifyVendorActivity({
      actor: req.admin,
      entityType: "campaign",
      entityId: duplicate._id,
      action: "duplicated",
      title: "Campaign duplicated",
      itemName: duplicate.name,
    });

    const payload = await buildCampaignDetailPayload(duplicate._id, scopeMatch);
    return res.status(201).json(payload);
  } catch (error) {
    return res.status(400).json({
      message: error.message || "Unable to duplicate campaign",
    });
  }
};

const scheduleCampaign = async (req, res) => {
  const scheduledAtInput = req.body.scheduledAt || new Date();
  const scheduledAt = parseDateTimeInput(scheduledAtInput);

  if (!scheduledAt) {
    return res.status(400).json({ message: "Invalid scheduled time" });
  }

  if (scheduledAt <= new Date()) {
    try {
      const result = await dispatchCampaign(req.params.id, {
        mode: "scheduled",
        scopeMatch: buildVendorMatch(req),
      });
      return res.json({
        message: "Campaign sent immediately because the scheduled time is due",
        campaign: result.campaign,
        sentCount: result.sentCount,
      });
    } catch (error) {
      return res.status(400).json({ message: error.message || "Unable to send campaign" });
    }
  }

  const scopeMatch = buildVendorMatch(req);
  const existingCampaign = await EmailCampaign.findOne({ _id: req.params.id, ...scopeMatch });

  if (!existingCampaign) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: req.params.id, ...scopeMatch },
    {
      status: "scheduled",
      scheduledAt,
      sentAt: null,
    },
    {
      returnDocument: "after",
      runValidators: true,
    }
  );

  if (!campaign) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  await refreshCampaignRecipientEstimate(campaign._id);

  await logCampaignActivity(campaign._id, "scheduled", "Campaign scheduled", {
    scheduledAt: campaign.scheduledAt,
  });
  await notifyVendorActivity({
    actor: req.admin,
    entityType: "campaign",
    entityId: campaign._id,
    action: "scheduled",
    title: "Campaign scheduled",
    itemName: campaign.name,
  });

  const payload = await buildCampaignDetailPayload(campaign._id, scopeMatch);
  return res.json(payload);
};

const pauseCampaign = async (req, res) => {
  const scopeMatch = buildVendorMatch(req);
  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: req.params.id, ...scopeMatch },
    { status: "paused" },
    { returnDocument: "after", runValidators: true }
  );

  if (!campaign) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  await logCampaignActivity(campaign._id, "paused", "Campaign paused");
  await notifyVendorActivity({
    actor: req.admin,
    entityType: "campaign",
    entityId: campaign._id,
    action: "paused",
    title: "Campaign paused",
    itemName: campaign.name,
  });
  const payload = await buildCampaignDetailPayload(campaign._id, scopeMatch);
  return res.json(payload);
};

const resumeCampaign = async (req, res) => {
  const scopeMatch = buildVendorMatch(req);
  const existingCampaign = await EmailCampaign.findOne({ _id: req.params.id, ...scopeMatch });

  if (!existingCampaign) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: req.params.id, ...scopeMatch },
    {
      status: existingCampaign.scheduledAt ? "scheduled" : "draft",
    },
    { returnDocument: "after", runValidators: true }
  );

  await logCampaignActivity(campaign._id, "resumed", "Campaign resumed");
  await notifyVendorActivity({
    actor: req.admin,
    entityType: "campaign",
    entityId: campaign._id,
    action: "resumed",
    title: "Campaign resumed",
    itemName: campaign.name,
  });
  const payload = await buildCampaignDetailPayload(campaign._id, scopeMatch);
  return res.json(payload);
};

const archiveCampaign = async (req, res) => {
  const scopeMatch = buildVendorMatch(req);
  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: req.params.id, ...scopeMatch },
    { status: "archived" },
    { returnDocument: "after", runValidators: true }
  );

  if (!campaign) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  await logCampaignActivity(campaign._id, "archived", "Campaign archived");
  await notifyVendorActivity({
    actor: req.admin,
    entityType: "campaign",
    entityId: campaign._id,
    action: "archived",
    title: "Campaign archived",
    itemName: campaign.name,
  });
  const payload = await buildCampaignDetailPayload(campaign._id, scopeMatch);
  return res.json(payload);
};

const markCampaignAsSent = async (req, res) => {
  const scopeMatch = buildVendorMatch(req);
  const campaign = await EmailCampaign.findOneAndUpdate(
    { _id: req.params.id, ...scopeMatch },
    {
      status: "sent",
      sentAt: req.body.sentAt || new Date(),
    },
    {
      returnDocument: "after",
      runValidators: true,
    }
  );

  if (!campaign) {
    return res.status(404).json({ message: "Campaign not found" });
  }

  await logCampaignActivity(campaign._id, "sent", "Campaign marked as sent", {
    sentAt: campaign.sentAt,
  });
  await notifyVendorActivity({
    actor: req.admin,
    entityType: "campaign",
    entityId: campaign._id,
    action: "marked sent",
    title: "Campaign marked sent",
    itemName: campaign.name,
  });

  const payload = await buildCampaignDetailPayload(campaign._id, scopeMatch);
  return res.json(payload);
};

export {
  getCampaignMeta,
  listCampaigns,
  getCampaignById,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  duplicateCampaign,
  scheduleCampaign,
  pauseCampaign,
  resumeCampaign,
  archiveCampaign,
  markCampaignAsSent,
};
