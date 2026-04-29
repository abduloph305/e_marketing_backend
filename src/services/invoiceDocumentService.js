import { isValidObjectId } from "mongoose";
import Admin from "../models/Admin.js";
import BillingInvoice from "../models/BillingInvoice.js";
import { env } from "../config/env.js";
import { sendTransactionalEmail } from "./sesService.js";

const company = {
  name: "SellersLogin",
  tagline: "Email Marketing Simplified",
  legalName: "SellersLogin Solutions",
  address: "India",
  gstin: "GSTIN not provided",
  email: env.automationFromEmail || env.adminEmail || "billing@sellerslogin.com",
  website: "www.sellerslogin.com",
  supportEmail: env.adminEmail || env.automationFromEmail || "support@sellerslogin.com",
};

const escapeHtml = (value = "") =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const escapePdf = (value = "") =>
  String(value || "")
    .replace(/[^\x20-\x7E]/g, "")
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");

const formatDate = (value = new Date()) =>
  new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(value || Date.now()));

const formatCurrency = (value = 0, currency = "INR") =>
  new Intl.NumberFormat("en-IN", {
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(Number(value || 0));

const formatPdfCurrency = (value = 0) =>
  `Rs. ${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(Number(value || 0))}`;

const findVendor = async (vendorId = "") => {
  const ownershipMatch = [{ sellersloginVendorId: String(vendorId || "") }];
  if (isValidObjectId(vendorId)) {
    ownershipMatch.push({ _id: vendorId });
  }

  return Admin.findOne({ role: { $ne: "super_admin" }, $or: ownershipMatch })
    .select("name email phone businessName sellersloginVendorId")
    .lean();
};

const getInvoiceDocumentData = async ({ invoiceId, vendorId = "" }) => {
  const match = { _id: invoiceId };
  if (vendorId) {
    match.vendorId = vendorId;
  }

  const invoice = await BillingInvoice.findOne(match)
    .populate({
      path: "paymentId",
      populate: { path: "planId" },
    })
    .populate("subscriptionId")
    .lean();

  if (!invoice) {
    return null;
  }

  const vendor = await findVendor(invoice.vendorId);
  const payment = invoice.paymentId || {};
  const plan = payment.planId || {};
  const subscription = invoice.subscriptionId || {};
  const billingCycle = payment.metadata?.billingCycle === "yearly" ? "yearly" : "monthly";
  const periodStart = subscription.currentPeriodStart || payment.paidAt || invoice.issuedAt;
  const periodEnd = subscription.currentPeriodEnd || invoice.dueAt || invoice.issuedAt;
  const billingName = invoice.billingName || vendor?.businessName || vendor?.name || "Valued customer";
  const billingEmail = invoice.billingEmail || vendor?.email || "";
  const billingAddress = invoice.billingAddress || "Address not provided";
  const planName = plan.name || "Email Marketing Plan";

  return {
    invoice,
    payment,
    plan,
    subscription,
    vendor,
    company,
    billingCycle,
    periodStart,
    periodEnd,
    billingName,
    billingEmail,
    billingAddress,
    planName,
    lineItems: [
      {
        description: `${planName} (${billingCycle === "yearly" ? "Yearly" : "Monthly"} Subscription)`,
        detail: `${formatDate(periodStart)} - ${formatDate(periodEnd)}`,
        quantity: 1,
        unitPrice: invoice.subtotal,
        amount: invoice.subtotal,
      },
    ],
  };
};

const buildInvoiceHtml = (data) => {
  const { invoice, payment, plan, company: business, lineItems } = data;
  const cgst = Number(invoice.gstAmount || 0) / 2;
  const sgst = Number(invoice.gstAmount || 0) / 2;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invoice ${escapeHtml(invoice.invoiceNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f3fb; color: #101331; font-family: Inter, Arial, sans-serif; }
    .page { width: 100%; max-width: 980px; margin: 24px auto; background: #fff; border: 1px solid #ded7ef; padding: 36px; }
    .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; border-bottom: 3px solid #5236e8; padding-bottom: 26px; }
    .brand { display: flex; gap: 16px; align-items: center; }
    .mark { width: 68px; height: 68px; background: linear-gradient(135deg, #8338ec, #2f25d7); clip-path: polygon(8% 38%, 92% 8%, 66% 88%, 48% 58%, 30% 70%); }
    .brand h1 { margin: 0; font-size: 40px; line-height: 1; letter-spacing: 0; }
    .brand p, .muted { color: #6f6a8f; }
    .title { text-align: right; }
    .title h2 { margin: 0; color: #3126d3; font-size: 38px; letter-spacing: 0; }
    .badge { display: inline-block; margin-top: 14px; border: 1px solid #b7ebc4; background: #eafbf0; color: #087c26; padding: 9px 16px; font-weight: 700; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; margin-top: 28px; }
    .panel { border: 1px solid #e4def4; padding: 22px; min-height: 180px; }
    .label { color: #2f25d7; font-weight: 700; margin: 0 0 14px; }
    .facts { display: grid; gap: 18px; }
    .fact { display: grid; grid-template-columns: 150px 1fr; gap: 18px; }
    table { width: 100%; border-collapse: collapse; margin-top: 26px; border: 1px solid #e4def4; }
    th { background: #f6f2ff; color: #2f25d7; text-align: left; padding: 16px; }
    td { padding: 18px 16px; border-top: 1px solid #eee9f8; vertical-align: top; }
    .right { text-align: right; }
    .summary { display: grid; grid-template-columns: 1fr 440px; border: 1px solid #e4def4; border-top: 0; }
    .thanks { padding: 26px; }
    .totals { padding: 22px 26px; border-left: 1px solid #e4def4; }
    .row { display: flex; justify-content: space-between; gap: 18px; margin: 0 0 14px; }
    .total { border-top: 1px solid #cabcf6; padding-top: 18px; color: #2f25d7; font-size: 22px; font-weight: 800; }
    .paid { margin-top: 20px; background: #eafbf0; color: #087c26; padding: 16px; font-weight: 800; }
    .footer { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; margin-top: 28px; border-top: 3px solid #5236e8; padding-top: 24px; color: #5e5a78; }
    @media print { body { background: #fff; } .page { margin: 0; border: 0; max-width: none; } }
    @media (max-width: 760px) { .page { margin: 0; padding: 20px; } .top, .split, .summary, .footer { grid-template-columns: 1fr; display: grid; } .title { text-align: left; } .totals { border-left: 0; border-top: 1px solid #e4def4; } }
  </style>
</head>
<body>
  <main class="page">
    <section class="top">
      <div class="brand">
        <div class="mark"></div>
        <div><h1>${escapeHtml(business.name)}</h1><p>${escapeHtml(business.tagline)}</p></div>
      </div>
      <div class="title">
        <h2>INVOICE</h2>
        <p><strong>#${escapeHtml(invoice.invoiceNumber)}</strong></p>
        <span class="badge">${escapeHtml(invoice.status)}</span>
      </div>
    </section>

    <section class="split">
      <div>
        <p class="label">From</p>
        <h3>${escapeHtml(business.legalName)}</h3>
        <p class="muted">${escapeHtml(business.address)}</p>
        <p>GSTIN: ${escapeHtml(business.gstin)}</p>
        <p>Email: ${escapeHtml(business.email)}</p>
        <p>Website: ${escapeHtml(business.website)}</p>
      </div>
      <div class="facts">
        <div class="fact"><strong>Invoice Date</strong><span>${formatDate(invoice.issuedAt)}</span></div>
        <div class="fact"><strong>Payment Date</strong><span>${formatDate(payment.paidAt || invoice.issuedAt)}</span></div>
        <div class="fact"><strong>Billing Period</strong><span>${formatDate(data.periodStart)} - ${formatDate(data.periodEnd)}</span></div>
        <div class="fact"><strong>Payment Method</strong><span>${escapeHtml(payment.gateway || "manual")}</span></div>
      </div>
    </section>

    <section class="split">
      <div class="panel">
        <p class="label">Bill To</p>
        <h3>${escapeHtml(data.billingName)}</h3>
        <p>${escapeHtml(data.billingEmail)}</p>
        <p>${escapeHtml(data.vendor?.phone || "")}</p>
        <p>${escapeHtml(data.billingAddress)}</p>
        ${invoice.gstNumber ? `<p>GSTIN: ${escapeHtml(invoice.gstNumber)}</p>` : ""}
      </div>
      <div class="panel">
        <p class="label">Plan Details</p>
        <p><strong>Plan Name:</strong> ${escapeHtml(data.planName)}</p>
        <p><strong>Daily Emails:</strong> ${Number(plan.emailsPerDay || 0).toLocaleString("en-IN")}</p>
        <p><strong>Emails / Month:</strong> ${Number(plan.emailsPerMonth || 0).toLocaleString("en-IN")}</p>
        <p><strong>Plan Amount:</strong> ${formatCurrency(invoice.subtotal, invoice.currency)} / ${escapeHtml(data.billingCycle)}</p>
      </div>
    </section>

    <table>
      <thead><tr><th>#</th><th>Description</th><th class="right">Quantity</th><th class="right">Unit Price</th><th class="right">Amount</th></tr></thead>
      <tbody>
        ${lineItems.map((item, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(item.description)}</strong><br><span class="muted">${escapeHtml(item.detail)}</span></td><td class="right">${item.quantity}</td><td class="right">${formatCurrency(item.unitPrice, invoice.currency)}</td><td class="right">${formatCurrency(item.amount, invoice.currency)}</td></tr>`).join("")}
      </tbody>
    </table>
    <section class="summary">
      <div class="thanks">
        <p class="label">Thank you for choosing SellersLogin!</p>
        <p class="muted">Your subscription has been activated successfully.</p>
        <p class="muted">Need help? Contact us at ${escapeHtml(business.supportEmail)}</p>
      </div>
      <div class="totals">
        <p class="row"><span>Subtotal</span><strong>${formatCurrency(invoice.subtotal, invoice.currency)}</strong></p>
        <p class="row"><span>CGST (9%)</span><strong>${formatCurrency(cgst, invoice.currency)}</strong></p>
        <p class="row"><span>SGST (9%)</span><strong>${formatCurrency(sgst, invoice.currency)}</strong></p>
        <p class="row total"><span>Total</span><span>${formatCurrency(invoice.total, invoice.currency)}</span></p>
        <p class="paid">Amount Paid <span style="float:right">${formatCurrency(invoice.total, invoice.currency)}</span></p>
      </div>
    </section>
    <section class="footer">
      <div><strong>Notes</strong><p>This is a computer generated invoice. No signature required.</p></div>
      <div><strong>Secure. Reliable. Compliant.</strong><p>All your data is protected with enterprise-grade security.</p></div>
    </section>
  </main>
</body>
</html>`;
};

const createPdf = (commands) => {
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const content = commands.join("\n");
  const catalog = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  addObject("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>");
  addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  addObject(`<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
};

const buildInvoicePdf = (data) => {
  const { invoice, payment, plan, company: business } = data;
  const commands = [];
  const text = (value, x, y, size = 10, font = "F1", color = "0 0 0") => {
    commands.push(`BT /${font} ${size} Tf ${color} rg ${x} ${y} Td (${escapePdf(value)}) Tj ET`);
  };
  const line = (x1, y1, x2, y2, color = "0.32 0.21 0.91") => {
    commands.push(`${color} RG ${x1} ${y1} m ${x2} ${y2} l S`);
  };
  const rect = (x, y, w, h, fill = "1 1 1", stroke = "0.89 0.86 0.95") => {
    commands.push(`${fill} rg ${stroke} RG ${x} ${y} ${w} ${h} re B`);
  };

  commands.push("0.49 0.22 0.93 rg 36 780 m 76 806 l 58 752 l 48 772 l f");
  text(business.name, 86, 786, 28, "F2", "0.06 0.07 0.19");
  text(business.tagline, 88, 768, 11, "F1", "0.42 0.40 0.56");
  text("INVOICE", 455, 786, 26, "F2", "0.18 0.15 0.83");
  text(`#${invoice.invoiceNumber}`, 454, 766, 11, "F2");
  rect(478, 730, 70, 24, "0.91 0.98 0.94", "0.66 0.91 0.72");
  text(invoice.status.toUpperCase(), 496, 738, 10, "F2", "0.03 0.49 0.15");
  line(36, 716, 558, 716);

  text("From", 36, 690, 11, "F2", "0.18 0.15 0.83");
  text(business.legalName, 36, 668, 15, "F2");
  text(business.address, 36, 648, 10);
  text(`GSTIN: ${business.gstin}`, 36, 626, 10);
  text(`Email: ${business.email}`, 36, 608, 10);
  text(`Website: ${business.website}`, 36, 590, 10);
  line(300, 690, 300, 585, "0.88 0.86 0.95");
  text("Invoice Date", 322, 668, 11, "F2");
  text(formatDate(invoice.issuedAt), 432, 668, 10);
  text("Payment Date", 322, 640, 11, "F2");
  text(formatDate(payment.paidAt || invoice.issuedAt), 432, 640, 10);
  text("Billing Period", 322, 612, 11, "F2");
  text(`${formatDate(data.periodStart)} - ${formatDate(data.periodEnd)}`, 432, 612, 10);
  text("Payment Method", 322, 584, 11, "F2");
  text(payment.gateway || "manual", 432, 584, 10);

  rect(36, 438, 248, 120);
  rect(310, 438, 248, 120);
  text("Bill To", 52, 532, 12, "F2", "0.18 0.15 0.83");
  text(data.billingName, 52, 508, 13, "F2");
  text(data.billingEmail, 52, 490, 10);
  text(data.vendor?.phone || "", 52, 472, 10);
  text(data.billingAddress, 52, 450, 10);
  text("Plan Details", 326, 532, 12, "F2", "0.18 0.15 0.83");
  text(`Plan Name: ${data.planName}`, 326, 506, 11);
  text(`Daily Emails: ${Number(plan.emailsPerDay || 0).toLocaleString("en-IN")}`, 326, 482, 11);
  text(`Emails / Month: ${Number(plan.emailsPerMonth || 0).toLocaleString("en-IN")}`, 326, 458, 11);

  rect(36, 382, 522, 34, "0.96 0.95 1", "0.89 0.86 0.95");
  text("#", 52, 394, 10, "F2", "0.18 0.15 0.83");
  text("Description", 92, 394, 10, "F2", "0.18 0.15 0.83");
  text("Quantity", 340, 394, 10, "F2", "0.18 0.15 0.83");
  text("Unit Price", 412, 394, 10, "F2", "0.18 0.15 0.83");
  text("Amount", 504, 394, 10, "F2", "0.18 0.15 0.83");
  rect(36, 312, 522, 70);
  text("1", 52, 354, 10);
  text(data.lineItems[0].description, 92, 354, 11, "F2");
  text(data.lineItems[0].detail, 92, 334, 9, "F1", "0.42 0.40 0.56");
  text("1", 358, 354, 10);
  text(formatPdfCurrency(invoice.subtotal), 408, 354, 10);
  text(formatPdfCurrency(invoice.subtotal), 502, 354, 10);

  rect(36, 186, 272, 126);
  rect(308, 186, 250, 126);
  text("Thank you for choosing SellersLogin!", 52, 266, 12, "F2", "0.18 0.15 0.83");
  text("Your subscription has been activated successfully.", 52, 244, 10);
  text(`Need help? Contact us at ${business.supportEmail}`, 52, 224, 10);
  text("Subtotal", 334, 278, 10);
  text(formatPdfCurrency(invoice.subtotal), 478, 278, 10);
  text("CGST (9%)", 334, 254, 10);
  text(formatPdfCurrency(Number(invoice.gstAmount || 0) / 2), 478, 254, 10);
  text("SGST (9%)", 334, 230, 10);
  text(formatPdfCurrency(Number(invoice.gstAmount || 0) / 2), 478, 230, 10);
  line(334, 214, 532, 214);
  text("Total", 334, 194, 15, "F2", "0.18 0.15 0.83");
  text(formatPdfCurrency(invoice.total), 452, 194, 15, "F2", "0.18 0.15 0.83");

  line(36, 72, 558, 72);
  text("Notes", 52, 48, 10, "F2", "0.18 0.15 0.83");
  text("This is a computer generated invoice. No signature required.", 52, 32, 9);
  text(`(c) ${new Date().getFullYear()} SellersLogin. All rights reserved.`, 378, 32, 9);

  return createPdf(commands);
};

const buildInvoiceEmailHtml = (data) => `
  <div style="margin:0;background:#f6f3fb;padding:28px;font-family:Arial,sans-serif;color:#101331;">
    <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #ded7ef;padding:28px;">
      <h1 style="margin:0;color:#21192d;">Your SellersLogin invoice is ready</h1>
      <p style="margin:14px 0 0;color:#6f6a8f;line-height:1.6;">Hi ${escapeHtml(data.billingName)}, your ${escapeHtml(data.planName)} subscription invoice is attached as a PDF.</p>
      <div style="margin:24px 0;padding:18px;background:#fbf8ff;border:1px solid #e4def4;">
        <p style="margin:0 0 10px;"><strong>Invoice:</strong> ${escapeHtml(data.invoice.invoiceNumber)}</p>
        <p style="margin:0 0 10px;"><strong>Total:</strong> ${formatCurrency(data.invoice.total, data.invoice.currency)}</p>
        <p style="margin:0;"><strong>Status:</strong> ${escapeHtml(data.invoice.status)}</p>
      </div>
      <p style="margin:0;color:#6f6a8f;">Thank you for choosing SellersLogin.</p>
    </div>
  </div>`;

const sendInvoiceEmail = async ({ invoiceId, vendorId = "" }) => {
  const data = await getInvoiceDocumentData({ invoiceId, vendorId });
  if (!data?.billingEmail) {
    return { skipped: true, reason: "billing_email_missing" };
  }

  const pdf = buildInvoicePdf(data);
  return sendTransactionalEmail({
    to: data.billingEmail,
    subject: `SellersLogin invoice ${data.invoice.invoiceNumber}`,
    html: buildInvoiceEmailHtml(data),
    text: `Your SellersLogin invoice ${data.invoice.invoiceNumber} is attached.`,
    attachments: [
      {
        filename: `SellersLogin-${data.invoice.invoiceNumber}.pdf`,
        contentType: "application/pdf",
        content: pdf,
      },
    ],
    tags: [
      { Name: "invoiceId", Value: String(data.invoice._id) },
      { Name: "vendorId", Value: String(data.invoice.vendorId) },
    ],
  });
};

export {
  buildInvoiceHtml,
  buildInvoicePdf,
  getInvoiceDocumentData,
  sendInvoiceEmail,
};
