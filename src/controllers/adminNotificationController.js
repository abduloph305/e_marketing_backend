import AdminNotification from "../models/AdminNotification.js";

const listAdminNotifications = async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

  const [notifications, unreadCount] = await Promise.all([
    AdminNotification.find().sort({ createdAt: -1 }).limit(limit).lean(),
    AdminNotification.countDocuments({ readAt: null }),
  ]);

  return res.json({
    notifications,
    unreadCount,
  });
};

const markAdminNotificationsRead = async (_req, res) => {
  const now = new Date();

  await AdminNotification.updateMany(
    { readAt: null },
    {
      $set: {
        readAt: now,
      },
    },
  );

  return res.json({ message: "Notifications marked as read", readAt: now });
};

export { listAdminNotifications, markAdminNotificationsRead };
