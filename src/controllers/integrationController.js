import IntegrationEvent from "../models/IntegrationEvent.js";
import Subscriber from "../models/Subscriber.js";
import { env } from "../config/env.js";
import { triggerWorkflowExecutionsForTriggers } from "../services/automationService.js";
import { attributeCampaignConversion } from "../services/campaignService.js";

const eventTriggerMap = {
  "user.registered": ["welcome_signup", "welcome_series"],
  "order.created": ["order_confirmation", "order_followup"],
  "order.completed": ["order_confirmation", "order_followup"],
  "payment.success": "payment_success",
  "shipping.updated": "shipping_update",
  "delivery.confirmed": "delivery_confirmation",
  "cart.abandoned": "abandoned_cart",
  "cart.created": "browse_abandonment",
  "lead.followup": "order_followup",
  "lead.reminder": "reminder_email",
  "reminder.due": "reminder_email",
  "discount.eligible": "discount_offer",
};

const eventSourceMap = {
  "user.registered": "website_signup",
  "order.created": "checkout",
  "order.completed": "checkout",
  "payment.success": "checkout",
  "shipping.updated": "checkout",
  "delivery.confirmed": "checkout",
  "cart.abandoned": "checkout",
  "cart.created": "checkout",
  "lead.followup": "crm",
  "lead.reminder": "crm",
  "reminder.due": "crm",
  "discount.eligible": "crm",
};

const titleCase = (value = "") =>
  String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

const deriveNamesFromEmail = (email = "") => {
  const localPart = String(email).split("@")[0] || "subscriber";
  const nameParts = localPart
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!nameParts.length) {
    return {
      firstName: "Subscriber",
      lastName: "Member",
    };
  }

  if (nameParts.length === 1) {
    return {
      firstName: titleCase(nameParts[0]),
      lastName: "Subscriber",
    };
  }

  return {
    firstName: titleCase(nameParts[0]),
    lastName: titleCase(nameParts.slice(1).join(" ")) || "Subscriber",
  };
};

const normalizeNameParts = (payload = {}, email = "") => {
  const derived = deriveNamesFromEmail(email);
  const name = String(payload.name || "").trim();
  const fullNameParts = name ? name.split(/\s+/).filter(Boolean) : [];

  return {
    firstName: String(payload.firstName || fullNameParts[0] || derived.firstName || "").trim(),
    lastName: String(
      payload.lastName || fullNameParts.slice(1).join(" ") || derived.lastName || "",
    ).trim(),
  };
};

const normalizeTags = (tags = []) =>
  Array.from(
    new Set(
      (Array.isArray(tags) ? tags : String(tags).split(","))
        .map((tag) => String(tag).trim())
        .filter(Boolean),
    ),
  );

const normalizeEmail = (value = "") => String(value).trim().toLowerCase();

const normalizeSourceLocation = (payload = {}) => {
  const rawValue = String(
    payload.sourceLocation ||
      payload.source_location ||
      payload.websiteSource ||
      payload.website_source ||
      payload.source ||
      "",
  )
    .trim()
    .toLowerCase();

  if (!rawValue) {
    return "manual";
  }

  if (["main_website", "ophmate", "ophmart", "main", "website"].includes(rawValue)) {
    return "main_website";
  }

  if (["vendor_website", "template", "template-vendor", "vendor"].includes(rawValue)) {
    return "vendor_website";
  }

  return rawValue;
};

const normalizeItem = (item = {}) => ({
  productId: String(item.productId || item.product_id || "").trim(),
  variantId: String(item.variantId || item.variant_id || "").trim(),
  name: String(item.name || item.product_name || "").trim(),
  quantity: Number(item.quantity || 0),
  unitPrice: Number(item.unitPrice || item.unit_price || 0),
  totalPrice: Number(item.totalPrice || item.total_price || 0),
  imageUrl: String(item.imageUrl || item.image_url || "").trim(),
  attributes:
    item.attributes && typeof item.attributes === "object"
      ? item.attributes
      : item.variant_attributes && typeof item.variant_attributes === "object"
        ? item.variant_attributes
        : {},
  vendorId: String(item.vendorId || item.vendor_id || "").trim(),
  categoryId: String(item.categoryId || item.category_id || "").trim(),
});

const normalizeShippingAddress = (address = {}) => ({
  label: String(address.label || "Home").trim(),
  fullName: String(address.fullName || address.full_name || "").trim(),
  phone: String(address.phone || "").trim(),
  line1: String(address.line1 || "").trim(),
  line2: String(address.line2 || "").trim(),
  city: String(address.city || "").trim(),
  state: String(address.state || "").trim(),
  pincode: String(address.pincode || "").trim(),
  country: String(address.country || "India").trim(),
});

const formatItemsSummary = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item) => {
      const normalized = normalizeItem(item);
      return [normalized.name, normalized.quantity ? `x${normalized.quantity}` : ""]
        .filter(Boolean)
        .join(" ");
    })
    .filter(Boolean)
    .join(", ");

const formatShippingAddressText = (address = {}) => {
  const normalized = normalizeShippingAddress(address);
  return [
    normalized.fullName,
    normalized.phone,
    normalized.line1,
    normalized.line2,
    [normalized.city, normalized.state, normalized.pincode].filter(Boolean).join(", "),
    normalized.country,
  ]
    .filter(Boolean)
    .join(" | ");
};

const toDateParts = (value) => {
  const date = value ? new Date(value) : new Date();

  if (Number.isNaN(date.getTime())) {
    return { orderDate: "", orderTime: "" };
  }

  return {
    orderDate: date.toLocaleDateString(),
    orderTime: date.toLocaleTimeString(),
  };
};

const getConfiguredWebhookSecrets = () =>
  Array.from(
    new Set(
      [
        env.ophmateWebhookSecret,
        process.env.OPHMATE_WEBHOOK_SECRET,
        process.env.MARKETING_WEBHOOK_SECRET,
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

const isLocalWebhookRequest = (req) => {
  const host = String(req.headers.host || "").trim().toLowerCase();

  return (
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]") ||
    host.startsWith("::1")
  );
};

const resolveSubscriberPayload = (payload = {}) => {
  const email = normalizeEmail(payload.email || payload.recipientEmail || "");
  const { firstName, lastName } = normalizeNameParts(payload, email);
  const items = Array.isArray(payload.items) ? payload.items.map(normalizeItem) : [];
  const shippingAddress = payload.shippingAddress ? normalizeShippingAddress(payload.shippingAddress) : null;
  const { orderDate, orderTime } = toDateParts(payload.orderPlacedAt || payload.timestamp || new Date().toISOString());

  return {
    email,
    firstName,
    lastName,
    phone: String(payload.phone || "").trim(),
    city: String(payload.city || "").trim(),
    state: String(payload.state || "").trim(),
    country: String(payload.country || "").trim(),
    customFields: {
      ...(typeof payload.customFields === "object" && payload.customFields ? payload.customFields : {}),
      ophmateUserId: payload.userId || payload.customerId || payload.externalUserId || "",
      ophmateOrderId: payload.orderId || payload.sourceEventId || "",
      ophmateOrderNumber: payload.orderNumber || "",
      ophmateOrderStatus: payload.orderStatus || "",
      ophmatePaymentStatus: payload.paymentStatus || "",
      ophmateDeliveryProvider: payload.deliveryProvider || "",
      ophmatePaymentMethod: payload.paymentMethod || "",
      ophmateEventType: payload.eventType || "",
      ophmateEventTimestamp: payload.timestamp || new Date().toISOString(),
      ophmateItems: items,
      ophmateItemsSummary: payload.orderSummary || formatItemsSummary(items),
      ophmateShippingAddress: shippingAddress,
      ophmateShippingAddressText: payload.metadata?.shippingAddressText || formatShippingAddressText(shippingAddress || {}),
      ophmateOrderPlacedAt: payload.orderPlacedAt || payload.timestamp || new Date().toISOString(),
      ophmateOrderDate: payload.metadata?.orderDate || orderDate,
      ophmateOrderTime: payload.metadata?.orderTime || orderTime,
      ophmateCartItems: items,
      ophmateCartItemsSummary: payload.orderSummary || formatItemsSummary(items),
    },
    source: eventSourceMap[payload.eventType] || payload.source || "manual",
    sourceLocation: normalizeSourceLocation(payload),
    tags: normalizeTags([
      ...(Array.isArray(payload.tags) ? payload.tags : []),
      payload.tag || "",
      payload.eventType === "user.registered" ? "new_user" : "",
      payload.eventType === "order.created" ? "order_created" : "",
      payload.eventType === "order.completed" ? "order_completed" : "",
      payload.eventType === "payment.success" ? "payment_success" : "",
      payload.eventType === "shipping.updated" ? "shipping_update" : "",
      payload.eventType === "delivery.confirmed" ? "delivery_confirmed" : "",
      payload.eventType === "cart.abandoned" ? "cart_abandoned" : "",
      payload.eventType === "cart.created" ? "cart_started" : "",
      payload.eventType === "reminder.due" ? "needs_reminder" : "",
      payload.eventType === "discount.eligible" ? "discount_offer" : "",
    ]),
    totalOrders: Number(payload.totalOrders || 0),
    totalSpent: Number(payload.totalSpent || 0),
    lastOrderDate:
      payload.lastOrderDate ||
      (payload.eventType === "order.created"
        ? payload.timestamp || new Date().toISOString()
        : null),
    lastEmailSentAt: null,
    lastOpenAt: null,
    lastClickAt: null,
    notes: String(payload.notes || "").trim(),
    status: payload.eventType === "user.registered" ? "subscribed" : payload.status || "subscribed",
  };
};

const upsertSubscriberFromEvent = async (payload) => {
  const email = normalizeEmail(payload.email || payload.recipientEmail || "");

  if (!email) {
    throw new Error("Email is required");
  }

  const nextSubscriberPayload = resolveSubscriberPayload(payload);
  const existing = await Subscriber.findOne({ email });

  if (!existing) {
    const subscriber = await Subscriber.create({
      ...nextSubscriberPayload,
      email,
      lastActivityAt: new Date(),
      engagementScore: payload.eventType === "user.registered" ? 0 : undefined,
    });

    return subscriber;
  }

  const nextCustomFields = {
    ...(existing.customFields || {}),
    ...nextSubscriberPayload.customFields,
  };

  const nextTags = normalizeTags([...(existing.tags || []), ...(nextSubscriberPayload.tags || [])]);
  const nextTotalOrders = Math.max(
    Number(existing.totalOrders || 0),
    Number(nextSubscriberPayload.totalOrders || 0),
  );
  const nextTotalSpent = Math.max(
    Number(existing.totalSpent || 0),
    Number(nextSubscriberPayload.totalSpent || 0),
  );

  const update = {
    firstName: nextSubscriberPayload.firstName || existing.firstName,
    lastName: nextSubscriberPayload.lastName || existing.lastName,
    phone: nextSubscriberPayload.phone || existing.phone || "",
    city: nextSubscriberPayload.city || existing.city || "",
    state: nextSubscriberPayload.state || existing.state || "",
    country: nextSubscriberPayload.country || existing.country || "",
    source: existing.source || nextSubscriberPayload.source,
    sourceLocation: existing.sourceLocation || nextSubscriberPayload.sourceLocation,
    tags: nextTags,
    totalOrders: nextTotalOrders,
    totalSpent: nextTotalSpent,
    lastOrderDate:
      nextSubscriberPayload.lastOrderDate ||
      existing.lastOrderDate ||
      null,
    lastActivityAt: new Date(),
    status:
      payload.eventType === "user.registered"
        ? "subscribed"
        : existing.status || nextSubscriberPayload.status,
    customFields: nextCustomFields,
  };

  if (payload.eventType === "user.registered") {
    update.status = "subscribed";
  }

  if (payload.eventType === "order.created") {
    update.totalOrders = Number(existing.totalOrders || 0) + 1;
    update.totalSpent = Number(existing.totalSpent || 0) + Number(payload.amount || 0);
    update.lastOrderDate = payload.timestamp ? new Date(payload.timestamp) : new Date();
    update.customFields.ophmateOrderId = payload.orderId || payload.sourceEventId || update.customFields.ophmateOrderId;
    update.customFields.ophmateOrderNumber = payload.orderNumber || update.customFields.ophmateOrderNumber;
    update.customFields.ophmateOrderStatus = payload.orderStatus || update.customFields.ophmateOrderStatus;
    update.customFields.ophmatePaymentMethod = payload.paymentMethod || update.customFields.ophmatePaymentMethod;
    update.customFields.ophmateItems = Array.isArray(payload.items) ? payload.items.map(normalizeItem) : update.customFields.ophmateItems || [];
    update.customFields.ophmateItemsSummary = payload.orderSummary || update.customFields.ophmateItemsSummary || "";
    update.customFields.ophmateShippingAddress = payload.shippingAddress ? normalizeShippingAddress(payload.shippingAddress) : update.customFields.ophmateShippingAddress || null;
    update.customFields.ophmateShippingAddressText = payload.metadata?.shippingAddressText || update.customFields.ophmateShippingAddressText || "";
    update.customFields.ophmateOrderPlacedAt = payload.orderPlacedAt || update.customFields.ophmateOrderPlacedAt || payload.timestamp || new Date().toISOString();
    update.customFields.ophmateOrderDate = payload.metadata?.orderDate || update.customFields.ophmateOrderDate || "";
    update.customFields.ophmateOrderTime = payload.metadata?.orderTime || update.customFields.ophmateOrderTime || "";
  }

  if (payload.eventType === "order.completed") {
    update.totalOrders = Math.max(
      Number(existing.totalOrders || 0) + 1,
      Number(payload.totalOrders || 0),
    );
    update.totalSpent = Math.max(Number(existing.totalSpent || 0), Number(payload.totalSpent || existing.totalSpent || 0));
    update.lastOrderDate = payload.timestamp ? new Date(payload.timestamp) : new Date();
    update.customFields.ophmateOrderStatus = "completed";
    update.customFields.ophmateCartStatus = "recovered";
    update.customFields.ophmatePaymentMethod = payload.paymentMethod || update.customFields.ophmatePaymentMethod;
    update.customFields.ophmateItems = Array.isArray(payload.items) ? payload.items.map(normalizeItem) : update.customFields.ophmateItems || [];
    update.customFields.ophmateItemsSummary = payload.orderSummary || update.customFields.ophmateItemsSummary || "";
    update.customFields.ophmateShippingAddress = payload.shippingAddress ? normalizeShippingAddress(payload.shippingAddress) : update.customFields.ophmateShippingAddress || null;
    update.customFields.ophmateShippingAddressText = payload.metadata?.shippingAddressText || update.customFields.ophmateShippingAddressText || "";
    update.customFields.ophmateOrderPlacedAt = payload.orderPlacedAt || update.customFields.ophmateOrderPlacedAt || payload.timestamp || new Date().toISOString();
    update.customFields.ophmateOrderDate = payload.metadata?.orderDate || update.customFields.ophmateOrderDate || "";
    update.customFields.ophmateOrderTime = payload.metadata?.orderTime || update.customFields.ophmateOrderTime || "";
  }

  if (payload.eventType === "payment.success") {
    update.customFields.ophmatePaymentStatus = "paid";
    update.customFields.ophmatePaymentId = payload.paymentId || "";
    update.customFields.ophmateOrderStatus = payload.orderStatus || update.customFields.ophmateOrderStatus;
    update.customFields.ophmatePaymentMethod = payload.paymentMethod || update.customFields.ophmatePaymentMethod;
    update.customFields.ophmateItems = Array.isArray(payload.items) ? payload.items.map(normalizeItem) : update.customFields.ophmateItems || [];
    update.customFields.ophmateItemsSummary = payload.orderSummary || update.customFields.ophmateItemsSummary || "";
    update.customFields.ophmateShippingAddress = payload.shippingAddress ? normalizeShippingAddress(payload.shippingAddress) : update.customFields.ophmateShippingAddress || null;
    update.customFields.ophmateShippingAddressText = payload.metadata?.shippingAddressText || update.customFields.ophmateShippingAddressText || "";
    update.customFields.ophmateOrderPlacedAt = payload.orderPlacedAt || update.customFields.ophmateOrderPlacedAt || payload.timestamp || new Date().toISOString();
    update.customFields.ophmateOrderDate = payload.metadata?.orderDate || update.customFields.ophmateOrderDate || "";
    update.customFields.ophmateOrderTime = payload.metadata?.orderTime || update.customFields.ophmateOrderTime || "";
    update.totalSpent = Math.max(Number(existing.totalSpent || 0), Number(payload.totalSpent || existing.totalSpent || 0));
  }

  if (payload.eventType === "shipping.updated") {
    update.customFields.ophmateShippingStatus = payload.shippingStatus || payload.status || "updated";
    update.customFields.ophmateTrackingNumber = payload.trackingNumber || "";
    update.customFields.ophmateTrackingUrl = payload.trackingUrl || "";
  }

  if (payload.eventType === "delivery.confirmed") {
    update.customFields.ophmateDeliveryStatus = "delivered";
    update.customFields.ophmateDeliveredAt = payload.timestamp || new Date().toISOString();
  }

  if (payload.eventType === "cart.created") {
    update.customFields.ophmateCartStatus = "active";
    update.customFields.ophmateCartUpdatedAt = payload.timestamp || new Date().toISOString();
    update.customFields.ophmateCartValue = Number(payload.amount || existing.customFields?.ophmateCartValue || 0);
    update.customFields.ophmateCartItems = Array.isArray(payload.items) ? payload.items.map(normalizeItem) : update.customFields.ophmateCartItems || [];
    update.customFields.ophmateCartItemsSummary = payload.orderSummary || update.customFields.ophmateCartItemsSummary || "";
  }

  if (payload.eventType === "cart.abandoned") {
    update.customFields.ophmateCartStatus = "abandoned";
    update.customFields.ophmateCartUpdatedAt = payload.timestamp || new Date().toISOString();
    update.customFields.ophmateCartValue = Number(payload.amount || existing.customFields?.ophmateCartValue || 0);
    update.customFields.ophmateCartItems = Array.isArray(payload.items) ? payload.items.map(normalizeItem) : existing.customFields?.ophmateCartItems || [];
    update.customFields.ophmateCartItemsSummary = payload.orderSummary || update.customFields.ophmateCartItemsSummary || "";
  }

  if (payload.eventType === "reminder.due") {
    update.customFields.ophmateReminderStatus = "due";
    update.customFields.ophmateReminderType = payload.reminderType || "general";
  }

  if (payload.eventType === "discount.eligible") {
    update.customFields.ophmateDiscountEligible = true;
    update.customFields.ophmateDiscountCode = payload.discountCode || existing.customFields?.ophmateDiscountCode || "";
  }

  return Subscriber.findByIdAndUpdate(existing._id, update, {
    returnDocument: "after",
    runValidators: true,
  });
};

const buildEventQuery = (payload = {}) => {
  const sourceEventId = String(payload.sourceEventId || payload.eventId || payload.orderId || "").trim();

  if (!sourceEventId) {
    return null;
  }

  return {
    source: String(payload.source || "ophmate").trim().toLowerCase(),
    sourceEventId,
    eventType: String(payload.eventType || "").trim(),
  };
};

const createIntegrationEvent = async (payload, subscriberId, status = "received", errorMessage = "") => {
  const query = buildEventQuery(payload);
  const baseDoc = {
    source: String(payload.source || "ophmate").trim().toLowerCase(),
    eventType: String(payload.eventType || "").trim(),
    sourceEventId: String(payload.sourceEventId || payload.eventId || payload.orderId || "").trim(),
    recipientEmail: normalizeEmail(payload.email || payload.recipientEmail || ""),
    payload,
  };

  if (query) {
    try {
      return await IntegrationEvent.findOneAndUpdate(
        query,
        {
          $setOnInsert: baseDoc,
          $set: {
            subscriberId: subscriberId || null,
            status,
            processedAt: baseDoc.processedAt,
            workflowResults: baseDoc.workflowResults,
            errorMessage,
          },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await IntegrationEvent.findOne(query);
        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  return IntegrationEvent.create(baseDoc);
};

const ensureWebhookSecret = (req, res) => {
  const configuredSecrets = getConfiguredWebhookSecrets();

  if (!configuredSecrets.length) {
    return true;
  }

  const incomingSecret = String(req.headers["x-webhook-secret"] || req.headers["x-integration-secret"] || "").trim();

  if (configuredSecrets.includes(incomingSecret)) {
    return true;
  }

  if (isLocalWebhookRequest(req)) {
    if (incomingSecret) {
      console.warn("Allowing local webhook request with mismatched secret");
    }

    return true;
  }

  res.status(401).json({ message: "Invalid webhook secret" });
  return false;
};

const ingestOphmateEvent = async (req, res) => {
  if (!ensureWebhookSecret(req, res)) {
    return;
  }

  const payload = {
    ...(req.body || {}),
    source: String(req.body?.source || "ophmate").trim().toLowerCase(),
    sourceLocation: normalizeSourceLocation(req.body || {}),
    eventType: String(req.body?.eventType || "").trim(),
    email: normalizeEmail(req.body?.email || req.body?.recipientEmail || ""),
  };

  if (!payload.eventType) {
    return res.status(400).json({ message: "Event type is required" });
  }

  if (!payload.email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const subscriber = await upsertSubscriberFromEvent(payload);
    const storedEvent = await createIntegrationEvent(payload, subscriber?._id, "received");

    let conversionResult = null;
    if (["order.completed", "payment.success"].includes(payload.eventType)) {
      conversionResult = await attributeCampaignConversion({
        campaignId: null,
        email: payload.email,
        convertedAt: payload.timestamp ? new Date(payload.timestamp) : new Date(),
        revenueAttributed: Number(payload.amount || payload.totalSpent || 0),
        sourceEventId: payload.sourceEventId || payload.eventId || payload.orderId || "",
        sourceEventType: payload.eventType,
      });
    }

    const triggers = eventTriggerMap[payload.eventType];
    let workflowResults = [];

    if (triggers) {
      workflowResults = await triggerWorkflowExecutionsForTriggers({
        triggers,
        subscriberId: subscriber?._id || null,
        context: {
          source: "ophmate",
          sourceLocation: normalizeSourceLocation(payload),
          eventType: payload.eventType,
          sourceEventId: payload.sourceEventId || payload.eventId || payload.orderId || "",
          orderId: payload.orderId || "",
          orderNumber: payload.orderNumber || "",
          paymentId: payload.paymentId || "",
          shippingStatus: payload.shippingStatus || payload.status || "",
          trackingNumber: payload.trackingNumber || "",
          trackingUrl: payload.trackingUrl || "",
          amount: payload.amount || 0,
          currency: payload.currency || "INR",
          metadata: payload.metadata || {},
        },
      });
    }

    await IntegrationEvent.findByIdAndUpdate(storedEvent._id, {
      status: workflowResults.length ? "processed" : "ignored",
      processedAt: new Date(),
      workflowResults,
      errorMessage: "",
      subscriberId: subscriber?._id || null,
    });

    return res.status(200).json({
      success: true,
      message: "Event processed",
      eventType: payload.eventType,
      trigger: triggers || null,
      workflowCount: workflowResults.length,
      conversionAttributed: Boolean(conversionResult),
    });
  } catch (error) {
    try {
      await createIntegrationEvent(payload, null, "failed", error.message || "Failed to process event");
    } catch {
      // Ignore secondary persistence errors.
    }

    return res.status(400).json({
      success: false,
      message: error.message || "Unable to process event",
    });
  }
};

export { ingestOphmateEvent };
