import crypto from "crypto";
import bcrypt from "bcryptjs";
import Admin from "../models/Admin.js";
import { rolePermissions } from "../config/roles.js";
import { env } from "../config/env.js";
import { notifyVendorActivity } from "../services/adminNotificationService.js";
import { assertFeatureLimit } from "../services/billingService.js";
import { sendTransactionalEmail } from "../services/sesService.js";
import { getRequestVendorId } from "../utils/vendorScope.js";

const allowedPermissions = new Set(rolePermissions.super_admin);

const permissionLabels = {
  view_dashboard: "Dashboard",
  manage_campaigns: "Campaigns",
  edit_content: "Templates and Builder",
  manage_audience: "Audience and Segments",
  manage_automations: "Automations",
  view_analytics: "Analytics and Deliverability",
  view_reports: "Reports",
  export_reports: "Export reports",
  manage_settings: "Settings",
};

const escapeHtml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const invitePageSummary = (permissions = []) =>
  permissions
    .map((permission) => permissionLabels[permission] || permission)
    .filter(Boolean);

const generatePassword = (length = 12) => {
  const bytes = Math.ceil(length * 1.25);
  return crypto.randomBytes(bytes).toString("base64url").slice(0, length);
};

const normalizePermissions = (permissions = []) => {
  const selected = Array.isArray(permissions) ? permissions : [];
  const normalized = selected
    .map((permission) => String(permission || "").trim())
    .filter((permission) => allowedPermissions.has(permission));

  if (!normalized.includes("view_dashboard")) {
    normalized.unshift("view_dashboard");
  }

  return Array.from(new Set(normalized));
};

const buildInviteEmailHtml = ({
  name,
  email,
  password,
  permissions,
  dashboardUrl,
}) => {
  const pages = invitePageSummary(permissions);

  return `
    <div style="margin:0;background:#f5f7ef;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#101828;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e7ebdd;border-radius:28px;overflow:hidden;">
        <div style="padding:32px 32px 24px;background:linear-gradient(180deg,#fbfdf6 0%,#ffffff 100%);border-bottom:1px solid #eef2e4;">
          <div style="display:inline-flex;align-items:center;gap:8px;border:1px solid #d7e3bf;background:#f7ffef;color:#4f7c2a;border-radius:999px;padding:8px 14px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">
            Invite granted
          </div>
          <h1 style="margin:18px 0 0;font-size:30px;line-height:1.2;color:#101828;">You have access to the Email Marketing Dashboard</h1>
          <p style="margin:12px 0 0;font-size:16px;line-height:1.7;color:#667085;">Hi ${escapeHtml(name || "there")}, your workspace access has been created. Use the credentials below to sign in and start working with your assigned sections.</p>
        </div>
        <div style="padding:32px;">
          <table role="presentation" style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:0 0 12px;font-size:13px;color:#667085;">Email</td>
              <td style="padding:0 0 12px;font-size:16px;color:#101828;font-weight:700;text-align:right;">${escapeHtml(email)}</td>
            </tr>
            <tr>
              <td style="padding:0 0 12px;font-size:13px;color:#667085;">Dashboard link</td>
              <td style="padding:0 0 12px;font-size:16px;color:#101828;font-weight:700;text-align:right;">${escapeHtml(dashboardUrl)}</td>
            </tr>
            <tr>
              <td style="padding:0 0 12px;font-size:13px;color:#667085;">Password</td>
              <td style="padding:0 0 12px;font-size:16px;color:#101828;font-weight:700;text-align:right;">${escapeHtml(password)}</td>
            </tr>
          </table>
          <div style="margin-top:24px;border:1px solid #e7ebdd;border-radius:24px;padding:18px 20px;background:#fcfdf8;">
            <p style="margin:0 0 10px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#98a26d;">Allowed access</p>
            <div style="display:flex;flex-wrap:wrap;gap:10px;">
              ${pages
                .map(
                  (page) =>
                    `<span style="display:inline-flex;align-items:center;border:1px solid #dbe7c5;background:#ffffff;border-radius:999px;padding:8px 12px;font-size:13px;font-weight:600;color:#344054;">${escapeHtml(page)}</span>`,
                )
                .join("")}
            </div>
          </div>
          <div style="margin-top:28px;text-align:center;">
            <a href="${dashboardUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;border-radius:999px;padding:14px 24px;font-size:15px;font-weight:700;">Open dashboard</a>
          </div>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#98a2b3;">If you did not expect this invite, you can ignore this email. Credentials should be kept private.</p>
        </div>
      </div>
    </div>
  `;
};

const listTeamUsers = async (req, res) => {
  const vendorId = getRequestVendorId(req);
  const match = { role: { $ne: "super_admin" } };

  if (vendorId) {
    match.sellersloginVendorId = vendorId;
  }

  const users = await Admin.find(match).sort({
    createdAt: -1,
  });

  return res.json({
    users: users.map((user) => user.toSafeObject()),
  });
};

const saveTeamUser = async (req, res) => {
  const { name, email, status, permissions = [], role = "team_member" } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedName = String(name || "").trim();
  const accountStatus = status === "inactive" ? "inactive" : "active";
  const selectedPermissions = normalizePermissions(permissions);
  const dashboardUrl = `${env.clientUrl.replace(/\/$/, "")}/login`;
  const password = generatePassword();
  const vendorId = getRequestVendorId(req);

  if (!normalizedName) {
    return res.status(400).json({ message: "Name is required" });
  }

  if (!normalizedEmail) {
    return res.status(400).json({ message: "Email is required" });
  }

  const existing = await Admin.findOne({ email: normalizedEmail });

  if (existing && existing.role === "super_admin") {
    return res.status(409).json({ message: "This email belongs to the main admin account" });
  }

  if (existing && vendorId && existing.sellersloginVendorId && existing.sellersloginVendorId !== vendorId) {
    return res.status(409).json({ message: "This email belongs to another workspace" });
  }

  if (!existing && vendorId) {
    await assertFeatureLimit(vendorId, "teamMembers");
  }

  const nextPasswordHash = await bcrypt.hash(password, 10);

  let user;

  if (existing) {
    user = await Admin.findByIdAndUpdate(
      existing._id,
      {
        $set: {
          name: normalizedName,
          email: normalizedEmail,
          role: role === "super_admin" ? "team_member" : role,
          sellersloginVendorId: existing.sellersloginVendorId || vendorId,
          businessName: existing.businessName || req.admin?.businessName || "",
          permissions: selectedPermissions,
          accountStatus,
          invitedAt: existing.invitedAt || new Date(),
          lastLoginAt: existing.lastLoginAt || null,
          password: nextPasswordHash,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );
  } else {
    user = await Admin.create({
      name: normalizedName,
      email: normalizedEmail,
      password: nextPasswordHash,
      role: role === "super_admin" ? "team_member" : role,
      sellersloginVendorId: vendorId,
      businessName: req.admin?.businessName || "",
      permissions: selectedPermissions,
      accountStatus,
      invitedAt: new Date(),
      lastLoginAt: null,
    });
  }

  let emailStatus = "sent";
  try {
    await sendTransactionalEmail({
      to: normalizedEmail,
      subject: "You have been invited to the Email Marketing Dashboard",
      html: buildInviteEmailHtml({
        name: normalizedName,
        email: normalizedEmail,
        password,
        permissions: selectedPermissions,
        dashboardUrl,
      }),
      text: [
        `Hi ${normalizedName || "there"},`,
        "",
        "You have been invited to the Email Marketing Dashboard.",
        `Dashboard link: ${dashboardUrl}`,
        `Email: ${normalizedEmail}`,
        `Password: ${password}`,
        `Allowed pages: ${invitePageSummary(selectedPermissions).join(", ") || "Dashboard"}`,
      ].join("\n"),
    });
  } catch (error) {
    emailStatus = "failed";
    console.error("Invite email failed", error);
  }

  await notifyVendorActivity({
    actor: req.admin,
    entityType: "team_member",
    entityId: user._id,
    action: existing ? "updated" : "created",
    title: existing ? "Team access updated" : "Team member invited",
    itemName: user.name,
  });

  return res.status(existing ? 200 : 201).json({
    message: existing ? "Team access updated" : "Team access created",
    user: user.toSafeObject(),
    generatedPassword: password,
    emailStatus,
  });
};

const updateTeamUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, status, permissions = [], role = "team_member" } = req.body || {};

  const user = await Admin.findById(id).select("+password");

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  if (user.role === "super_admin") {
    return res.status(403).json({ message: "The main admin account cannot be edited here" });
  }

  const normalizedEmail = String(email || user.email || "").trim().toLowerCase();
  const normalizedName = String(name || user.name || "").trim();
  const selectedPermissions = normalizePermissions(permissions);
  const vendorId = getRequestVendorId(req);

  if (vendorId && user.sellersloginVendorId !== vendorId) {
    return res.status(404).json({ message: "User not found" });
  }

  const emailChanged = normalizedEmail !== user.email;
  if (emailChanged) {
    const duplicate = await Admin.findOne({ email: normalizedEmail });
    if (duplicate && String(duplicate._id) !== String(user._id)) {
      return res.status(409).json({ message: "Another user already uses that email" });
    }
  }

  const updatedUser = await Admin.findByIdAndUpdate(
    user._id,
    {
      $set: {
        name: normalizedName,
        email: normalizedEmail,
        role: role === "super_admin" ? "team_member" : role,
        sellersloginVendorId: user.sellersloginVendorId || vendorId,
        permissions: selectedPermissions,
        accountStatus: status === "inactive" ? "inactive" : "active",
        invitedAt: user.invitedAt || new Date(),
      },
    },
    {
      new: true,
      runValidators: true,
    },
  );

  await notifyVendorActivity({
    actor: req.admin,
    entityType: "team_member",
    entityId: updatedUser._id,
    action: "updated",
    title: "Team access updated",
    itemName: updatedUser.name,
  });

  return res.json({
    message: "Team access updated",
    user: updatedUser.toSafeObject(),
  });
};

const deactivateTeamUser = async (req, res) => {
  const { id } = req.params;

  const user = await Admin.findById(id);
  const vendorId = getRequestVendorId(req);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  if (vendorId && user.sellersloginVendorId !== vendorId) {
    return res.status(404).json({ message: "User not found" });
  }

  if (user.role === "super_admin") {
    return res.status(403).json({ message: "The main admin account cannot be deactivated" });
  }

  user.accountStatus = "inactive";
  await user.save();

  await notifyVendorActivity({
    actor: req.admin,
    entityType: "team_member",
    entityId: user._id,
    action: "deactivated",
    title: "Team access deactivated",
    itemName: user.name,
  });

  return res.json({
    message: "Team access deactivated",
    user: user.toSafeObject(),
  });
};

export { deactivateTeamUser, listTeamUsers, saveTeamUser, updateTeamUser };
