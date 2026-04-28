const globalRoles = new Set(["super_admin"]);

const normalizeVendorId = (value = "") => String(value || "").trim();

const isGlobalAdmin = (admin = {}) => globalRoles.has(admin?.role);

const getRequestVendorId = (req = {}) => {
  const admin = req.admin || req.user || {};

  if (!admin || isGlobalAdmin(admin)) {
    return "";
  }

  return normalizeVendorId(admin.sellersloginVendorId || admin._id || admin.id);
};

const buildVendorMatch = (req = {}) => {
  const vendorId = getRequestVendorId(req);
  return vendorId ? { vendorId } : {};
};

const withVendorScope = (req = {}, match = {}) => ({
  ...match,
  ...buildVendorMatch(req),
});

const withVendorWrite = (req = {}, payload = {}) => {
  const vendorId = getRequestVendorId(req);
  return vendorId ? { ...payload, vendorId } : payload;
};

export {
  buildVendorMatch,
  getRequestVendorId,
  isGlobalAdmin,
  withVendorScope,
  withVendorWrite,
};
