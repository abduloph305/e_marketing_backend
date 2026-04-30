import UserActivityLog from "../models/UserActivityLog.js";

const moduleLabels = {
  automation: "Automations",
  automations: "Automations",
  billing: "Billing",
  campaign: "Campaigns",
  campaigns: "Campaigns",
  email: "Email events",
  login: "Login",
  segment: "Segments",
  segments: "Segments",
  settings: "Settings",
  subscriber: "Subscribers",
  subscribers: "Subscribers",
  template: "Templates",
  templates: "Templates",
};

const normalizeText = (value = "") => String(value || "").trim();

const getVendorDisplayName = (actor = {}) =>
  normalizeText(actor.businessName || actor.name || actor.email || "Vendor");

const getVendorId = (actor = {}) =>
  normalizeText(actor.sellersloginVendorId || actor._id || actor.id || "");

const getClientIp = (req = {}) =>
  normalizeText(
    req.headers?.["x-forwarded-for"]?.split(",")?.[0] ||
      req.headers?.["x-real-ip"] ||
      req.ip ||
      req.socket?.remoteAddress ||
      "",
  );

const getUserAgent = (req = {}) => normalizeText(req.headers?.["user-agent"] || "");

const toModule = (module = "", entityType = "") =>
  normalizeText(module || entityType || "activity").toLowerCase();

const toHumanAction = (action = "") =>
  normalizeText(action)
    .replace(/^workflow\./, "")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildDescription = ({ actor, action, entityType, entityName, title }) => {
  const actorName = getVendorDisplayName(actor);
  const readableAction = toHumanAction(action);
  const readableEntity = normalizeText(entityType || "activity");
  const item = normalizeText(entityName);

  if (actorName && readableAction && item) {
    return `${actorName} ${readableAction} ${readableEntity} "${item}"`;
  }

  if (actorName && title) {
    return `${actorName}: ${title}`;
  }

  return normalizeText(title || "Activity recorded");
};

const logUserActivity = async ({
  actor = null,
  req = null,
  module = "",
  action = "recorded",
  title = "",
  description = "",
  entityType = "",
  entityId = "",
  entityName = "",
  status = "completed",
  metadata = null,
}) => {
  const currentActor = actor || req?.admin || req?.user || null;

  if (!currentActor || currentActor.role !== "vendor") {
    return null;
  }

  try {
    const normalizedModule = toModule(module, entityType);
    return await UserActivityLog.create({
      vendorId: getVendorId(currentActor),
      actorAdminId: currentActor._id || currentActor.id || null,
      actorName: getVendorDisplayName(currentActor),
      actorEmail: normalizeText(currentActor.email).toLowerCase(),
      module: normalizedModule,
      action: normalizeText(action) || "recorded",
      title: normalizeText(title) || "Activity recorded",
      description:
        normalizeText(description) ||
        buildDescription({
          actor: currentActor,
          action,
          entityType: entityType || normalizedModule,
          entityName,
          title,
        }),
      entityType: normalizeText(entityType || normalizedModule),
      entityId: entityId ? String(entityId) : "",
      entityName: normalizeText(entityName),
      status: normalizeText(status) || "completed",
      metadata,
      ipAddress: req ? getClientIp(req) : "",
      userAgent: req ? getUserAgent(req) : "",
    });
  } catch (error) {
    console.error("Unable to log user activity", error);
    return null;
  }
};

const getModuleLabel = (module = "") => moduleLabels[module] || moduleLabels[toModule(module)] || "Activity";

export { getModuleLabel, logUserActivity };
