import EmailTemplate from "../models/EmailTemplate.js";

const normalizeTemplatePayload = (payload) => ({
  name: payload.name?.trim(),
  subject: payload.subject?.trim(),
  previewText: payload.previewText?.trim() || "",
  htmlContent: payload.htmlContent || "",
  designJson: payload.designJson || null,
});

const listTemplates = async (_req, res) => {
  const templates = await EmailTemplate.find().sort({ updatedAt: -1 });
  return res.json(templates);
};

const getTemplateById = async (req, res) => {
  const template = await EmailTemplate.findById(req.params.id);

  if (!template) {
    return res.status(404).json({ message: "Template not found" });
  }

  return res.json(template);
};

const createTemplate = async (req, res) => {
  try {
    const template = await EmailTemplate.create(normalizeTemplatePayload(req.body));
    return res.status(201).json(template);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Template name already exists" });
    }

    return res.status(400).json({ message: "Unable to create template" });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const template = await EmailTemplate.findByIdAndUpdate(
      req.params.id,
      normalizeTemplatePayload(req.body),
      {
        returnDocument: "after",
        runValidators: true,
      }
    );

    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    return res.json(template);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "Template name already exists" });
    }

    return res.status(400).json({ message: "Unable to update template" });
  }
};

const deleteTemplate = async (req, res) => {
  const template = await EmailTemplate.findByIdAndDelete(req.params.id);

  if (!template) {
    return res.status(404).json({ message: "Template not found" });
  }

  return res.json({ message: "Template deleted" });
};

export {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
