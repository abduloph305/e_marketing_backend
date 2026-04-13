const adminRoles = [
  "super_admin",
  "marketing_manager",
  "content_editor",
  "analyst",
  "read_only",
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
};

const getPermissionsForRole = (role) => rolePermissions[role] || rolePermissions.read_only;

const hasPermission = (role, permission) => getPermissionsForRole(role).includes(permission);

export { adminRoles, rolePermissions, getPermissionsForRole, hasPermission };
