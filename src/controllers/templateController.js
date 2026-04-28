import EmailTemplate from "../models/EmailTemplate.js";
import { notifyVendorActivity } from "../services/adminNotificationService.js";
import { assertFeatureLimit } from "../services/billingService.js";
import { getRequestVendorId } from "../utils/vendorScope.js";
import { buildVendorMatch, withVendorWrite } from "../utils/vendorScope.js";

const normalizeTemplatePayload = (payload) => ({
  name: payload.name?.trim(),
  subject: payload.subject?.trim(),
  previewText: payload.previewText?.trim() || "",
  htmlContent: payload.htmlContent || "",
  designJson: payload.designJson || null,
});

const listTemplates = async (req, res) => {
  const templates = await EmailTemplate.find(buildVendorMatch(req)).sort({ updatedAt: -1 });
  return res.json(templates);
};

const getTemplateById = async (req, res) => {
  const template = await EmailTemplate.findOne({ _id: req.params.id, ...buildVendorMatch(req) });

  if (!template) {
    return res.status(404).json({ message: "Template not found" });
  }

  return res.json(template);
};

const createTemplate = async (req, res) => {
  try {
    await assertFeatureLimit(getRequestVendorId(req), "templates");
    const template = await EmailTemplate.create(withVendorWrite(req, normalizeTemplatePayload(req.body)));
    await notifyVendorActivity({
      actor: req.admin,
      entityType: "template",
      entityId: template._id,
      action: "created",
      title: "Template created",
      itemName: template.name,
    });
    return res.status(201).json(template);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Template name already exists" });
    }

    return res.status(error.status || 400).json({ message: error.message || "Unable to create template" });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const template = await EmailTemplate.findOneAndUpdate(
      { _id: req.params.id, ...buildVendorMatch(req) },
      normalizeTemplatePayload(req.body),
      {
        returnDocument: "after",
        runValidators: true,
      }
    );

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    await notifyVendorActivity({
      actor: req.admin,
      entityType: "template",
      entityId: template._id,
      action: "updated",
      title: "Template updated",
      itemName: template.name,
    });
    return res.json(template);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Template name already exists" });
    }

    return res.status(400).json({ message: "Unable to update template" });
  }
};

const deleteTemplate = async (req, res) => {
  const template = await EmailTemplate.findOneAndDelete({ _id: req.params.id, ...buildVendorMatch(req) });

  if (!template) {
    return res.status(404).json({ message: "Template not found" });
  }

  await notifyVendorActivity({
    actor: req.admin,
    entityType: "template",
    entityId: template._id,
    action: "deleted",
    title: "Template deleted",
    itemName: template.name,
  });

  return res.json({ message: "Template deleted" });
};

export {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
