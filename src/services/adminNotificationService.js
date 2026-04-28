import AdminNotification from "../models/AdminNotification.js";

const getVendorDisplayName = (admin = {}) =>
  String(admin.businessName || admin.name || admin.email || "Vendor").trim();

const getVendorId = (admin = {}) =>
  String(admin.sellersloginVendorId || admin._id || admin.id || "").trim();

const createAdminNotification = async ({
  actor = null,
  title,
  message,
  type = "activity",
  entityType = "",
  entityId = "",
  action = "",
  metadata = {},
}) => {
  if (!actor || actor.role !== "vendor") {
    return null;
  }

  try {
    return await AdminNotification.create({
      title,
      message,
      type,
      vendorId: getVendorId(actor),
      vendorName: getVendorDisplayName(actor),
      actorAdminId: actor._id || actor.id || null,
      entityType,
      entityId: entityId ? String(entityId) : "",
      action,
      ...metadata,
    });
  } catch (error) {
    console.error("Unable to create admin notification", error);
    return null;
  }
};

const notifyVendorLogin = (vendor) =>
  createAdminNotification({
    actor: vendor,
    title: "Vendor login",
    message: `${getVendorDisplayName(vendor)} logged in to Email Marketing`,
    type: "vendor_login",
    entityType: "vendor",
    entityId: getVendorId(vendor),
    action: "login",
  });

const notifyVendorActivity = ({
  actor,
  entityType,
  entityId,
  action,
  title,
  itemName = "",
}) => {
  const vendorName = getVendorDisplayName(actor);
  const readableEntity = entityType === "automation" ? "automation" : entityType;
  const itemSuffix = itemName ? `: ${itemName}` : "";

  return createAdminNotification({
    actor,
    title,
    message: `${vendorName} ${action} ${readableEntity}${itemSuffix}`,
    type: "vendor_activity",
    entityType,
    entityId,
    action,
  });
};

export { createAdminNotification, notifyVendorActivity, notifyVendorLogin };
