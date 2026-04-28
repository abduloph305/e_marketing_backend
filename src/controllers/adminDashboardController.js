import Admin from "../models/Admin.js";
import AdminNotification from "../models/AdminNotification.js";
import AutomationLog from "../models/AutomationLog.js";
import AutomationWorkflow from "../models/AutomationWorkflow.js";
import BillingInvoice from "../models/BillingInvoice.js";
import BillingPayment from "../models/BillingPayment.js";
import CampaignActivityLog from "../models/CampaignActivityLog.js";
import EmailCampaign from "../models/EmailCampaign.js";
import EmailEvent from "../models/EmailEvent.js";
import EmailTemplate from "../models/EmailTemplate.js";
import Segment from "../models/Segment.js";
import Subscriber from "../models/Subscriber.js";
import { getSubscriptionSnapshot } from "../services/billingService.js";

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
};

const toNumberMap = (rows, valueKey = "count") =>
  rows.reduce((acc, row) => {
    acc[String(row._id || "")] = row[valueKey] || 0;
    return acc;
  }, {});

const listPlatformOverview = async (_req, res) => {
  const vendorQuery = { role: "vendor" };
  const today = startOfToday();

  const [
    totalVendors,
    activeVendors,
    suspendedVendors,
    totalSubscribers,
    activeSubscribers,
    totalCampaigns,
    sentToday,
    campaignTotals,
    subscriberCounts,
    campaignCounts,
    recentVendors,
    complaintEvents,
    bounceEvents,
  ] = await Promise.all([
    Admin.countDocuments(vendorQuery),
    Admin.countDocuments({ ...vendorQuery, accountStatus: { $ne: "inactive" } }),
    Admin.countDocuments({ ...vendorQuery, accountStatus: "inactive" }),
    Subscriber.countDocuments(),
    Subscriber.countDocuments({ status: "subscribed" }),
    EmailCampaign.countDocuments(),
    EmailEvent.countDocuments({ eventType: "send", timestamp: { $gte: today } }),
    EmailCampaign.aggregate([
      {
        $group: {
          _id: null,
          sent: { $sum: "$totals.sent" },
          delivered: { $sum: "$totals.delivered" },
          bounces: { $sum: "$totals.bounces" },
          complaints: { $sum: "$totals.complaints" },
        },
      },
    ]),
    Subscriber.aggregate([{ $group: { _id: "$vendorId", count: { $sum: 1 } } }]),
    EmailCampaign.aggregate([
      {
        $group: {
          _id: "$vendorId",
          count: { $sum: 1 },
          sent: { $sum: "$totals.sent" },
          bounces: { $sum: "$totals.bounces" },
          complaints: { $sum: "$totals.complaints" },
        },
      },
    ]),
    Admin.find(vendorQuery).sort({ createdAt: -1 }).limit(8),
    EmailEvent.countDocuments({ eventType: "complaint" }),
    EmailEvent.countDocuments({ eventType: "bounce" }),
  ]);

  const subscribersByVendor = toNumberMap(subscriberCounts);
  const campaignsByVendor = campaignCounts.reduce((acc, row) => {
    acc[String(row._id || "")] = {
      count: row.count || 0,
      sent: row.sent || 0,
      bounces: row.bounces || 0,
      complaints: row.complaints || 0,
    };
    return acc;
  }, {});

  const totals = campaignTotals[0] || {};

  const vendors = recentVendors.map((vendor) => {
    const vendorKey = vendor.sellersloginVendorId || String(vendor._id);
    const vendorCampaigns = campaignsByVendor[vendorKey] || {};
    const sent = vendorCampaigns.sent || 0;

    return {
      id: vendor.id,
      name: vendor.name,
      email: vendor.email,
      businessName: vendor.businessName || "",
      sellersloginVendorId: vendor.sellersloginVendorId || "",
      accountStatus: vendor.accountStatus || "active",
      lastLoginAt: vendor.lastLoginAt,
      createdAt: vendor.createdAt,
      subscribers: subscribersByVendor[vendorKey] || 0,
      campaigns: vendorCampaigns.count || 0,
      emailsSent: sent,
      bounceRate: sent ? Number((((vendorCampaigns.bounces || 0) / sent) * 100).toFixed(2)) : 0,
      complaintRate: sent ? Number((((vendorCampaigns.complaints || 0) / sent) * 100).toFixed(2)) : 0,
    };
  });

  const totalSent = totals.sent || 0;
  const bounceRate = totalSent ? Number((((totals.bounces || 0) / totalSent) * 100).toFixed(2)) : 0;
  const complaintRate = totalSent
    ? Number((((totals.complaints || 0) / totalSent) * 100).toFixed(2))
    : 0;

  return res.json({
    stats: {
      totalVendors,
      activeVendors,
      suspendedVendors,
      totalSubscribers,
      activeSubscribers,
      totalCampaigns,
      emailsSentToday: sentToday,
      emailsSentTotal: totalSent,
      deliveredTotal: totals.delivered || 0,
      bounceRate,
      complaintRate,
      activeSubscriptions: 0,
      monthlyRevenue: 0,
    },
    riskAlerts: [
      { label: "Suspended vendors", count: suspendedVendors, tone: "danger" },
      { label: "Bounce events", count: bounceEvents, tone: "warning" },
      { label: "Complaint events", count: complaintEvents, tone: "danger" },
      { label: "Unverified users", count: 0, tone: "muted" },
    ],
    recentPayments: [],
    vendors,
  });
};

const listEmailMarketingVendors = async (_req, res) => {
  const vendorQuery = {
    role: "vendor",
    sellersloginVendorId: { $exists: true, $ne: "" },
    lastLoginAt: { $ne: null },
  };

  const [vendors, subscriberCounts, campaignCounts] = await Promise.all([
    Admin.find(vendorQuery).sort({ lastLoginAt: -1, createdAt: -1 }),
    Subscriber.aggregate([{ $group: { _id: "$vendorId", count: { $sum: 1 } } }]),
    EmailCampaign.aggregate([
      {
        $group: {
          _id: "$vendorId",
          count: { $sum: 1 },
          sent: { $sum: "$totals.sent" },
          delivered: { $sum: "$totals.delivered" },
          bounces: { $sum: "$totals.bounces" },
          complaints: { $sum: "$totals.complaints" },
        },
      },
    ]),
  ]);

  const subscribersByVendor = toNumberMap(subscriberCounts);
  const campaignsByVendor = campaignCounts.reduce((acc, row) => {
    acc[String(row._id || "")] = {
      count: row.count || 0,
      sent: row.sent || 0,
      delivered: row.delivered || 0,
      bounces: row.bounces || 0,
      complaints: row.complaints || 0,
    };
    return acc;
  }, {});

  const vendorRows = vendors.map((vendor) => {
    const vendorKey = vendor.sellersloginVendorId || String(vendor._id);
    const vendorCampaigns = campaignsByVendor[vendorKey] || {};
    const sent = vendorCampaigns.sent || 0;

    return {
      id: vendor.id,
      name: vendor.name,
      email: vendor.email,
      phone: vendor.phone || "",
      businessName: vendor.businessName || "",
      sellersloginVendorId: vendor.sellersloginVendorId || "",
      sellersloginAccountType: vendor.sellersloginAccountType || "",
      sellersloginActorId: vendor.sellersloginActorId || "",
      sellersloginPageAccess: vendor.sellersloginPageAccess || [],
      sellersloginWebsiteAccess: vendor.sellersloginWebsiteAccess || [],
      accountStatus: vendor.accountStatus || "active",
      lastLoginAt: vendor.lastLoginAt,
      createdAt: vendor.createdAt,
      updatedAt: vendor.updatedAt,
      subscribers: subscribersByVendor[vendorKey] || 0,
      campaigns: vendorCampaigns.count || 0,
      emailsSent: sent,
      delivered: vendorCampaigns.delivered || 0,
      bounceRate: sent ? Number((((vendorCampaigns.bounces || 0) / sent) * 100).toFixed(2)) : 0,
      complaintRate: sent ? Number((((vendorCampaigns.complaints || 0) / sent) * 100).toFixed(2)) : 0,
    };
  });

  const activeVendors = vendorRows.filter((vendor) => vendor.accountStatus !== "inactive").length;

  return res.json({
    stats: {
      total: vendorRows.length,
      active: activeVendors,
      suspended: vendorRows.length - activeVendors,
      subscribers: vendorRows.reduce((sum, vendor) => sum + vendor.subscribers, 0),
      campaigns: vendorRows.reduce((sum, vendor) => sum + vendor.campaigns, 0),
      emailsSent: vendorRows.reduce((sum, vendor) => sum + vendor.emailsSent, 0),
    },
    vendors: vendorRows,
  });
};

const getEmailMarketingVendorProfile = async (req, res) => {
  const vendor = await Admin.findOne({ _id: req.params.id, role: "vendor" }).lean();

  if (!vendor) {
    return res.status(404).json({ message: "Vendor not found" });
  }

  const vendorKey = String(vendor.sellersloginVendorId || vendor._id);

  const [
    subscriptionSnapshot,
    subscriberCount,
    activeSubscriberCount,
    campaignRows,
    templateRows,
    automationRows,
    segmentRows,
    emailEventCounts,
    campaignTotals,
    invoices,
    payments,
    recentActivity,
  ] = await Promise.all([
    getSubscriptionSnapshot(vendorKey),
    Subscriber.countDocuments({ vendorId: vendorKey }),
    Subscriber.countDocuments({ vendorId: vendorKey, status: "subscribed" }),
    EmailCampaign.find({ vendorId: vendorKey })
      .sort({ updatedAt: -1 })
      .limit(8)
      .select("name subject status type totalRecipients totals sentAt scheduledAt createdAt updatedAt")
      .lean(),
    EmailTemplate.find({ vendorId: vendorKey })
      .sort({ updatedAt: -1 })
      .limit(8)
      .select("name subject createdAt updatedAt")
      .lean(),
    AutomationWorkflow.find({ vendorId: vendorKey })
      .sort({ updatedAt: -1 })
      .limit(8)
      .select("name trigger status isActive executionCount createdAt updatedAt")
      .lean(),
    Segment.find({ vendorId: vendorKey })
      .sort({ updatedAt: -1 })
      .limit(8)
      .select("name description createdAt updatedAt")
      .lean(),
    EmailEvent.aggregate([
      { $match: { vendorId: vendorKey } },
      { $group: { _id: "$eventType", count: { $sum: 1 } } },
    ]),
    EmailCampaign.aggregate([
      { $match: { vendorId: vendorKey } },
      {
        $group: {
          _id: null,
          campaigns: { $sum: 1 },
          recipients: { $sum: "$totalRecipients" },
          sent: { $sum: "$totals.sent" },
          delivered: { $sum: "$totals.delivered" },
          opens: { $sum: "$totals.opens" },
          clicks: { $sum: "$totals.clicks" },
          bounces: { $sum: "$totals.bounces" },
          complaints: { $sum: "$totals.complaints" },
        },
      },
    ]),
    BillingInvoice.find({ vendorId: vendorKey }).sort({ issuedAt: -1 }).limit(6).lean(),
    BillingPayment.find({ vendorId: vendorKey }).sort({ createdAt: -1 }).limit(6).lean(),
    AdminNotification.find({ vendorId: vendorKey }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  const totals = campaignTotals[0] || {};
  const eventMap = toNumberMap(emailEventCounts);
  const sent = totals.sent || eventMap.send || 0;

  return res.json({
    vendor: {
      id: String(vendor._id),
      name: vendor.name,
      email: vendor.email,
      phone: vendor.phone || "",
      businessName: vendor.businessName || "",
      sellersloginVendorId: vendor.sellersloginVendorId || "",
      sellersloginAccountType: vendor.sellersloginAccountType || "",
      sellersloginActorId: vendor.sellersloginActorId || "",
      sellersloginPageAccess: vendor.sellersloginPageAccess || [],
      sellersloginWebsiteAccess: vendor.sellersloginWebsiteAccess || [],
      accountStatus: vendor.accountStatus || "active",
      lastLoginAt: vendor.lastLoginAt,
      createdAt: vendor.createdAt,
      updatedAt: vendor.updatedAt,
    },
    billing: {
      subscription: subscriptionSnapshot?.subscription || null,
      plan: subscriptionSnapshot?.plan || null,
      usage: subscriptionSnapshot?.usage || {},
      featureUsage: subscriptionSnapshot?.featureUsage || {},
      remainingToday: subscriptionSnapshot?.remainingToday || 0,
      remainingThisMonth: subscriptionSnapshot?.remainingThisMonth || 0,
      invoices,
      payments,
    },
    marketing: {
      subscribers: subscriberCount,
      activeSubscribers: activeSubscriberCount,
      campaigns: totals.campaigns || campaignRows.length,
      templates: subscriptionSnapshot?.featureUsage?.templates?.used || templateRows.length,
      automations: subscriptionSnapshot?.featureUsage?.automations?.used || automationRows.length,
      segments: subscriptionSnapshot?.featureUsage?.segments?.used || segmentRows.length,
      recipients: totals.recipients || 0,
      sent,
      delivered: totals.delivered || 0,
      opens: totals.opens || eventMap.open || 0,
      clicks: totals.clicks || eventMap.click || 0,
      bounces: totals.bounces || eventMap.bounce || 0,
      complaints: totals.complaints || eventMap.complaint || 0,
      bounceRate: sent ? Number((((totals.bounces || eventMap.bounce || 0) / sent) * 100).toFixed(2)) : 0,
      complaintRate: sent ? Number((((totals.complaints || eventMap.complaint || 0) / sent) * 100).toFixed(2)) : 0,
    },
    recent: {
      campaigns: campaignRows,
      templates: templateRows,
      automations: automationRows,
      segments: segmentRows,
      activity: recentActivity,
    },
  });
};

const listVendorActivity = async (_req, res) => {
  const vendorQuery = {
    role: "vendor",
    sellersloginVendorId: { $exists: true, $ne: "" },
    lastLoginAt: { $ne: null },
  };

  const vendors = await Admin.find(vendorQuery).sort({ lastLoginAt: -1, createdAt: -1 }).lean();
  const vendorKeys = vendors.map((vendor) => String(vendor.sellersloginVendorId || vendor._id));
  const vendorObjectIds = vendors.map((vendor) => vendor._id);
  const vendorByKey = vendors.reduce((acc, vendor) => {
    const key = String(vendor.sellersloginVendorId || vendor._id);
    acc[key] = vendor;
    acc[String(vendor._id)] = vendor;
    return acc;
  }, {});

  if (!vendorKeys.length) {
    return res.json({
      stats: {
        vendors: 0,
        logins: 0,
        emailsSent: 0,
        campaigns: 0,
        bounceRate: 0,
        complaintRate: 0,
      },
      activities: [],
    });
  }

  const [
    notifications,
    campaignLogs,
    recentCampaigns,
    recentEmailEvents,
    automationLogs,
    emailEventCounts,
    campaignTotals,
  ] = await Promise.all([
    AdminNotification.find({
      $or: [{ vendorId: { $in: vendorKeys } }, { actorAdminId: { $in: vendorObjectIds } }],
    })
      .sort({ createdAt: -1 })
      .limit(80)
      .lean(),
    CampaignActivityLog.find({ vendorId: { $in: vendorKeys } })
      .sort({ createdAt: -1 })
      .limit(80)
      .lean(),
    EmailCampaign.find({ vendorId: { $in: vendorKeys } })
      .sort({ updatedAt: -1 })
      .limit(60)
      .select("vendorId name subject status type totalRecipients totals sentAt scheduledAt createdAt updatedAt")
      .lean(),
    EmailEvent.find({ vendorId: { $in: vendorKeys } })
      .sort({ timestamp: -1 })
      .limit(80)
      .select("vendorId campaignId recipientEmail eventType timestamp bounceType bounceSubType complaintFeedbackType")
      .lean(),
    AutomationLog.find({ vendorId: { $in: vendorKeys } })
      .sort({ createdAt: -1 })
      .limit(60)
      .lean(),
    EmailEvent.aggregate([
      { $match: { vendorId: { $in: vendorKeys } } },
      { $group: { _id: "$eventType", count: { $sum: 1 } } },
    ]),
    EmailCampaign.aggregate([
      { $match: { vendorId: { $in: vendorKeys } } },
      {
        $group: {
          _id: null,
          campaigns: { $sum: 1 },
          sent: { $sum: "$totals.sent" },
          bounces: { $sum: "$totals.bounces" },
          complaints: { $sum: "$totals.complaints" },
        },
      },
    ]),
  ]);

  const getVendor = (key) => vendorByKey[String(key || "")] || {};
  const getVendorName = (vendor) =>
    String(vendor.businessName || vendor.name || vendor.email || "Vendor").trim();
  const toVendorSummary = (key) => {
    const vendor = getVendor(key);
    return {
      id: String(vendor._id || ""),
      vendorId: String(vendor.sellersloginVendorId || key || ""),
      name: getVendorName(vendor),
      email: vendor.email || "",
      accountStatus: vendor.accountStatus || "active",
    };
  };

  const eventCountMap = toNumberMap(emailEventCounts);
  const totals = campaignTotals[0] || {};
  const totalSent = totals.sent || eventCountMap.send || 0;
  const totalBounces = totals.bounces || eventCountMap.bounce || 0;
  const totalComplaints = totals.complaints || eventCountMap.complaint || 0;

  const activities = [
    ...notifications.map((item) => ({
      id: `notification-${item._id}`,
      category: item.type === "vendor_login" ? "login" : "activity",
      type: item.type || "activity",
      title: item.title,
      message: item.message,
      vendor: toVendorSummary(item.vendorId || item.actorAdminId),
      entityType: item.entityType || "",
      action: item.action || "",
      status: item.readAt ? "read" : "new",
      timestamp: item.createdAt,
    })),
    ...campaignLogs.map((item) => ({
      id: `campaign-log-${item._id}`,
      category: "campaign",
      type: item.type,
      title: "Campaign activity",
      message: item.message,
      vendor: toVendorSummary(item.vendorId),
      entityType: "campaign",
      entityId: String(item.campaignId || ""),
      action: item.type,
      status: item.type,
      timestamp: item.createdAt,
    })),
    ...recentCampaigns.map((campaign) => ({
      id: `campaign-${campaign._id}`,
      category: "campaign",
      type: campaign.status,
      title: campaign.name,
      message: `${campaign.subject} · ${campaign.status}`,
      vendor: toVendorSummary(campaign.vendorId),
      entityType: "campaign",
      entityId: String(campaign._id),
      action: campaign.status,
      status: campaign.status,
      metrics: {
        recipients: campaign.totalRecipients || 0,
        sent: campaign.totals?.sent || 0,
        delivered: campaign.totals?.delivered || 0,
        bounces: campaign.totals?.bounces || 0,
        complaints: campaign.totals?.complaints || 0,
      },
      timestamp: campaign.updatedAt || campaign.createdAt,
    })),
    ...recentEmailEvents.map((event) => ({
      id: `email-event-${event._id}`,
      category: "email",
      type: event.eventType,
      title: `Email ${event.eventType}`,
      message: event.recipientEmail,
      vendor: toVendorSummary(event.vendorId),
      entityType: "email_event",
      entityId: String(event.campaignId || ""),
      action: event.eventType,
      status: event.eventType,
      metadata: {
        bounceType: event.bounceType || "",
        bounceSubType: event.bounceSubType || "",
        complaintFeedbackType: event.complaintFeedbackType || "",
      },
      timestamp: event.timestamp,
    })),
    ...automationLogs.map((item) => ({
      id: `automation-log-${item._id}`,
      category: "automation",
      type: item.eventType,
      title: "Automation activity",
      message: item.message,
      vendor: toVendorSummary(item.vendorId),
      entityType: "automation",
      entityId: String(item.workflowId || ""),
      action: item.eventType,
      status: item.level,
      timestamp: item.createdAt,
    })),
  ]
    .filter((item) => item.timestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 160);

  return res.json({
    stats: {
      vendors: vendors.length,
      logins: notifications.filter((item) => item.type === "vendor_login").length,
      emailsSent: totalSent,
      campaigns: totals.campaigns || recentCampaigns.length,
      bounceRate: totalSent ? Number(((totalBounces / totalSent) * 100).toFixed(2)) : 0,
      complaintRate: totalSent ? Number(((totalComplaints / totalSent) * 100).toFixed(2)) : 0,
    },
    activities,
  });
};

const updateVendorStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({ message: "Status must be active or inactive" });
  }

  const vendor = await Admin.findOneAndUpdate(
    { _id: id, role: "vendor" },
    { $set: { accountStatus: status } },
    { new: true },
  );

  if (!vendor) {
    return res.status(404).json({ message: "Vendor not found" });
  }

  return res.json({
    message: status === "inactive" ? "Vendor suspended" : "Vendor activated",
    vendor: vendor.toSafeObject(),
  });
};

export {
  getEmailMarketingVendorProfile,
  listEmailMarketingVendors,
  listPlatformOverview,
  listVendorActivity,
  updateVendorStatus,
};
