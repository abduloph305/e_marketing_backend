const adminRoles = [
  "super_admin",
  "marketing_manager",
  "content_editor",
  "analyst",
  "read_only",
  "team_member",
];

const rolePermissions = {
  super_admin: [
    "view_dashboard",
    "manage_campaigns",
    "edit_content",
    "manage_audience",
    "manage_automations",
    "view_analytics",
    "view_reports",
    "export_reports",
    "manage_team_access",
    "manage_settings",
  ],
  marketing_manager: [
    "view_dashboard",
    "manage_campaigns",
    "edit_content",
    "manage_audience",
    "manage_automations",
    "view_analytics",
    "view_reports",
    "export_reports",
  ],
  content_editor: [
    "view_dashboard",
    "manage_campaigns",
    "edit_content",
    "view_analytics",
    "view_reports",
  ],
  analyst: [
    "view_dashboard",
    "view_analytics",
    "view_reports",
    "export_reports",
  ],
  read_only: ["view_dashboard", "view_analytics", "view_reports"],
  team_member: [],
};

const getPermissionsForRole = (role) => rolePermissions[role] || rolePermissions.read_only;

const hasPermission = (role, permission) => getPermissionsForRole(role).includes(permission);

const canAccessPermission = (admin, permission) => {
  if (!permission) {
    return true;
  }

  if (Array.isArray(admin?.permissions) && admin.permissions.includes(permission)) {
    return true;
  }

  return hasPermission(admin?.role || "read_only", permission);
};

export { adminRoles, rolePermissions, getPermissionsForRole, hasPermission, canAccessPermission };
