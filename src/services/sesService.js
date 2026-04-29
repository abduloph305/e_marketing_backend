import { randomUUID } from "crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env } from "../config/env.js";

let sesClient = null;

const ensureSesConfig = () => {
  if (!env.sesRegion || !env.sesAccessKeyId || !env.sesSecretAccessKey) {
    throw new Error("AWS SES credentials are missing");
  }
};

const getSesClient = () => {
  if (!sesClient) {
    ensureSesConfig();

    sesClient = new SESv2Client({
      region: env.sesRegion,
      credentials: {
        accessKeyId: env.sesAccessKeyId,
        secretAccessKey: env.sesSecretAccessKey,
      },
    });
  }

  return sesClient;
};

const getNestedValue = (object, path) => {
  if (!object || !path) {
    return "";
  }

  return String(path)
    .split(".")
    .reduce((value, key) => (value == null ? "" : value[key]), object);
};

const renderTemplate = (htmlContent, subscriber = {}) =>
  String(htmlContent || "").replace(/{{\s*([^}]+)\s*}}/g, (_match, token) => {
    const value = getNestedValue(subscriber, token.trim());

    if (value === null || value === undefined) {
      return "";
    }

    if (typeof value === "object") {
      return JSON.stringify(value);
    }

    return String(value);
  });

const escapeHtml = (value = "") =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const readTrackingAttribute = (attributes = "", name = "") => {
  if (!attributes || !name) {
    return "";
  }

  const pattern = new RegExp(`${name}=["']([^"']+)["']`, "i");
  const match = String(attributes).match(pattern);

  return match ? decodeURIComponent(match[1]) : "";
};

const appendTrackingParams = (baseUrl, params = {}) => {
  const url = String(baseUrl || "");
  const queryEntries = Object.entries(params).filter(([, value]) => value);

  if (!queryEntries.length) {
    return url;
  }

  const separator = url.includes("?") ? "&" : "?";
  const query = queryEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

  return `${url}${separator}${query}`;
};

const injectTrackingPixel = (html, trackingPixelUrl) => {
  if (!trackingPixelUrl) {
    return html;
  }

  const pixel = `<img src="${trackingPixelUrl}" alt="" width="1" height="1" style="display:none !important;opacity:0;border:0;visibility:hidden;" />`;

  if (html.includes("</body>")) {
    return html.replace("</body>", `${pixel}</body>`);
  }

  return `${html}${pixel}`;
};

const encodeMimeWord = (value = "") => {
  const text = String(value || "");

  if (!/[^\x00-\x7F]/.test(text)) {
    return text;
  }

  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
};

const wrapBase64 = (value = "") =>
  Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") || "";

const wrapBinaryBase64 = (value = "") =>
  Buffer.from(value)
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") || "";

const normalizeMimeType = (value = "") => String(value || "").split(";")[0].trim().toLowerCase();

const mimeTypeToExtension = (mimeType = "") => {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
  };

  return map[normalizeMimeType(mimeType)] || "png";
};

const isEmbeddableImageUrl = (url = "") => {
  const value = String(url || "").trim();

  if (!value) {
    return false;
  }

  if (value.startsWith("cid:") || value.startsWith("data:")) {
    return false;
  }

  return /^https?:\/\//i.test(value);
};

const fetchImageForInlineEmbedding = async (url, index) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      return null;
    }

    const contentType = normalizeMimeType(response.headers.get("content-type") || "");

    if (!contentType.startsWith("image/")) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (!buffer.length) {
      return null;
    }

    const maxInlineImageBytes = 8 * 1024 * 1024;
    if (buffer.length > maxInlineImageBytes) {
      return null;
    }

    const cid = `inline-image-${index}-${randomUUID()}`;
    const ext = mimeTypeToExtension(contentType);

    return {
      cid,
      contentType,
      filename: `inline-image-${index}.${ext}`,
      base64: buffer.toString("base64"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const embedInlineImagesInHtml = async (html = "") => {
  const input = String(html || "");
  const imageRegex = /<img\b([^>]*?)src=(["'])(.*?)\2([^>]*?)>/gi;
  const matches = [...input.matchAll(imageRegex)];

  if (!matches.length) {
    return {
      html: input,
      attachments: [],
    };
  }

  const uniqueUrls = [];
  const seen = new Set();

  for (const match of matches) {
    const src = String(match[3] || "").trim();
    if (!isEmbeddableImageUrl(src) || seen.has(src)) {
      continue;
    }

    seen.add(src);
    uniqueUrls.push(src);
  }

  if (!uniqueUrls.length) {
    return {
      html: input,
      attachments: [],
    };
  }

  const urlToEmbed = new Map();
  for (let index = 0; index < uniqueUrls.length; index += 1) {
    const url = uniqueUrls[index];
    const embedded = await fetchImageForInlineEmbedding(url, index + 1);
    if (embedded) {
      urlToEmbed.set(url, embedded);
    }
  }

  if (!urlToEmbed.size) {
    return {
      html: input,
      attachments: [],
    };
  }

  const rewrittenHtml = input.replace(imageRegex, (fullMatch, beforeSrc, quote, src, afterSrc) => {
    const embed = urlToEmbed.get(String(src || "").trim());

    if (!embed) {
      return fullMatch;
    }

    return `<img${beforeSrc}src=${quote}cid:${embed.cid}${quote}${afterSrc}>`;
  });

  return {
    html: rewrittenHtml,
    attachments: Array.from(urlToEmbed.values()),
  };
};

const buildRawMimeEmail = async ({
  fromName,
  fromEmail,
  replyTo = "",
  to,
  subject,
  text = "",
  html = "",
  attachments = [],
}) => {
  const multipartBoundary = `related_${randomUUID()}`;
  const alternativeBoundary = `alternative_${randomUUID()}`;
  const subjectLine = encodeMimeWord(subject || "");
  const fromLine = `${encodeMimeWord(fromName || "")} <${fromEmail}>`;
  const toLine = Array.isArray(to) ? to.join(", ") : String(to || "");

  const mimeParts = [
    `From: ${fromLine}`,
    `To: ${toLine}`,
    `Subject: ${subjectLine}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${multipartBoundary}"`,
  ];

  if (replyTo) {
    mimeParts.splice(2, 0, `Reply-To: ${replyTo}`);
  }

  const bodyParts = [
    `--${multipartBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(text || subject || ""),
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(html || ""),
    "",
    `--${alternativeBoundary}--`,
  ];

  const attachmentParts = attachments.map((attachment) => [
    `--${multipartBoundary}`,
    `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${attachment.disposition || "inline"}; filename="${attachment.filename}"`,
    ...(attachment.cid ? [`Content-ID: <${attachment.cid}>`] : []),
    "",
    wrapBinaryBase64(
      attachment.base64
        ? Buffer.from(attachment.base64, "base64")
        : Buffer.from(attachment.content || "")
    ),
    "",
  ].join("\r\n"));

  const closingParts = [
    ...mimeParts,
    "",
    bodyParts.join("\r\n"),
    ...attachmentParts,
    `--${multipartBoundary}--`,
    "",
  ];

  return closingParts.join("\r\n");
};

const rewriteTrackedLinks = (html, clickTrackingUrl) => {
  if (!clickTrackingUrl) {
    return html;
  }

  return html.replace(
    /<a\b([^>]*?)href=(["'])(.*?)\2([^>]*?)>/gi,
    (_match, before, quote, href, after) => {
      const trimmedHref = href.trim();
      const attrs = `${before} ${after}`;

      if (
        !trimmedHref ||
        trimmedHref.startsWith("#") ||
        trimmedHref.startsWith("mailto:") ||
        trimmedHref.startsWith("tel:") ||
        trimmedHref.startsWith("javascript:")
      ) {
        return `<a${before}href=${quote}${href}${quote}${after}>`;
      }

      const redirected = appendTrackingParams(clickTrackingUrl, {
        url: trimmedHref,
        blockId: readTrackingAttribute(attrs, "data-track-block"),
        section: readTrackingAttribute(attrs, "data-track-section"),
        ctaType: readTrackingAttribute(attrs, "data-track-cta-type"),
      });
      return `<a${before}href=${quote}${redirected}${quote}${after}>`;
    }
  );
};

const buildPersonalizedEmailPayload = ({
  campaign,
  recipient,
  mode = "campaign",
  tracking = null,
}) => ({
  FromEmailAddress: `${campaign.fromName} <${campaign.fromEmail}>`,
  Destination: {
    ToAddresses: [recipient.email],
  },
  ReplyToAddresses: campaign.replyTo ? [campaign.replyTo] : undefined,
  Content: {
    Simple: {
      Subject: {
        Data: campaign.subject,
      },
      Body: {
        Html: {
          Data: injectTrackingPixel(
            rewriteTrackedLinks(
              campaign.previewText
                ? `<!-- ${escapeHtml(campaign.previewText)} -->\n${renderTemplate(
                    campaign.templateId.htmlContent,
                    recipient
                  )}`
                : renderTemplate(campaign.templateId.htmlContent, recipient),
              tracking?.clickTrackingUrl || ""
            ),
            tracking?.trackingPixelUrl || ""
          ),
        },
        Text: {
          Data: campaign.previewText
            ? `${campaign.previewText}\n\n${campaign.subject}`
            : campaign.subject,
        },
      },
    },
  },
  EmailTags: [
    { Name: "campaignId", Value: String(campaign._id) },
    ...(recipient.subscriberId
      ? [{ Name: "subscriberId", Value: String(recipient.subscriberId) }]
      : []),
    { Name: "recipientEmail", Value: recipient.email },
    { Name: "mode", Value: mode },
  ],
  ConfigurationSetName: env.sesConfigurationSet || undefined,
});

const sendEmailCommand = async (payload) => {
  const client = getSesClient();
  const simpleHtml = payload?.Content?.Simple?.Body?.Html?.Data || "";
  const simpleText = payload?.Content?.Simple?.Body?.Text?.Data || "";

  if (simpleHtml) {
    const embedded = await embedInlineImagesInHtml(simpleHtml);
    if (embedded.attachments.length) {
      const rawMime = await buildRawMimeEmail({
        fromName: payload?.FromEmailAddress?.split("<")[0]?.trim() || env.automationFromName || "SellersLogin",
        fromEmail:
          payload?.FromEmailAddress?.match(/<([^>]+)>/)?.[1]?.trim() ||
          env.automationFromEmail ||
          env.adminEmail ||
          "",
        replyTo: Array.isArray(payload?.ReplyToAddresses) ? payload.ReplyToAddresses[0] || "" : "",
        to: payload?.Destination?.ToAddresses || [],
        subject: payload?.Content?.Simple?.Subject?.Data || "",
        text: simpleText || payload?.Content?.Simple?.Subject?.Data || "",
        html: embedded.html,
        attachments: embedded.attachments,
      });

      const response = await client.send(
        new SendEmailCommand({
          FromEmailAddress: payload.FromEmailAddress,
          Destination: payload.Destination,
          ReplyToAddresses: payload.ReplyToAddresses,
          Content: {
            Raw: {
              Data: Buffer.from(rawMime, "utf8"),
            },
          },
          EmailTags: payload.EmailTags,
          ConfigurationSetName: payload.ConfigurationSetName,
        })
      );

      return {
        messageId: response.MessageId,
      };
    }
  }

  const response = await client.send(new SendEmailCommand(payload));

  return {
    messageId: response.MessageId,
  };
};

const sendTestEmail = async ({ campaign, recipientEmail }) =>
  sendEmailCommand(
    buildPersonalizedEmailPayload({
      campaign,
      recipient: {
        email: recipientEmail,
        firstName: "Test",
        lastName: "Recipient",
      },
      mode: "test",
    })
  );

const sendCampaign = async ({ campaign, recipient, tracking = null }) =>
  sendEmailCommand(
    buildPersonalizedEmailPayload({
      campaign,
      recipient: {
        email: recipient.email,
        firstName: recipient.firstName,
        lastName: recipient.lastName,
        subscriberId: recipient._id,
      },
      tracking,
    })
  );

const buildAutomationEmailPayload = ({
  template,
  recipient,
  subject,
  previewText = "",
  fromName = env.automationFromName || "SellersLogin",
  fromEmail = env.automationFromEmail || env.adminEmail,
  replyTo = env.adminEmail || "",
  tracking = null,
}) => {
  if (!fromEmail) {
    throw new Error("Automation sender email is missing");
  }

  const renderedRecipient = {
    ...recipient,
    customFields: recipient.customFields || {},
  };

  const renderedSubject = renderTemplate(subject || template.subject || "Automation email", renderedRecipient);
  const renderedPreviewText = renderTemplate(previewText, renderedRecipient);
  const renderedHtml = template.htmlContent ? renderTemplate(template.htmlContent, renderedRecipient) : "";
  const content = template.htmlContent
    ? renderedHtml
    : "";

  const htmlContent = injectTrackingPixel(
    rewriteTrackedLinks(
      renderedPreviewText ? `<!-- ${escapeHtml(renderedPreviewText)} -->\n${content}` : content,
      tracking?.clickTrackingUrl || ""
    ),
    tracking?.trackingPixelUrl || ""
  );

  return {
    FromEmailAddress: `${fromName} <${fromEmail}>`,
    Destination: {
      ToAddresses: [recipient.email],
    },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    Content: {
      Simple: {
        Subject: {
          Data: renderedSubject,
        },
        Body: {
          Html: {
            Data: htmlContent,
          },
          Text: {
          Data: previewText
            ? `${renderedPreviewText}\n\n${renderedSubject}`
            : renderedSubject,
        },
      },
    },
    },
    EmailTags: [
      { Name: "mode", Value: "automation" },
      { Name: "recipientEmail", Value: recipient.email },
      ...(recipient.subscriberId
        ? [{ Name: "subscriberId", Value: String(recipient.subscriberId) }]
        : []),
    ],
    ConfigurationSetName: env.sesConfigurationSet || undefined,
  };
};

const sendAutomationEmail = async ({
  template,
  recipient,
  subject,
  previewText = "",
  tracking = null,
}) =>
  sendEmailCommand(
    buildAutomationEmailPayload({
      template,
      recipient,
      subject,
      previewText,
      tracking,
    })
  );

const sendTransactionalEmail = async ({
  to,
  subject,
  html,
  text = "",
  fromName = env.automationFromName || "SellersLogin",
  fromEmail = env.automationFromEmail || env.adminEmail,
  replyTo = env.adminEmail || "",
  tags = [],
  attachments = [],
}) => {
  if (!fromEmail) {
    throw new Error("Transactional sender email is missing");
  }

  if (attachments.length) {
    const rawMime = await buildRawMimeEmail({
      fromName,
      fromEmail,
      replyTo,
      to,
      subject,
      text: text || subject,
      html,
      attachments: attachments.map((attachment) => ({
        ...attachment,
        disposition: attachment.disposition || "attachment",
      })),
    });

    return sendEmailCommand({
      FromEmailAddress: `${fromName} <${fromEmail}>`,
      Destination: {
        ToAddresses: [to],
      },
      ReplyToAddresses: replyTo ? [replyTo] : undefined,
      Content: {
        Raw: {
          Data: Buffer.from(rawMime, "utf8"),
        },
      },
      EmailTags: [
        { Name: "mode", Value: "transactional" },
        { Name: "recipientEmail", Value: to },
        ...tags,
      ],
      ConfigurationSetName: env.sesConfigurationSet || undefined,
    });
  }

  return sendEmailCommand({
    FromEmailAddress: `${fromName} <${fromEmail}>`,
    Destination: {
      ToAddresses: [to],
    },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    Content: {
      Simple: {
        Subject: {
          Data: subject,
        },
        Body: {
          Html: {
            Data: html,
          },
          Text: {
            Data: text || subject,
          },
        },
      },
    },
    EmailTags: [
      { Name: "mode", Value: "transactional" },
      { Name: "recipientEmail", Value: to },
      ...tags,
    ],
    ConfigurationSetName: env.sesConfigurationSet || undefined,
  });
};

export {
  buildPersonalizedEmailPayload,
  buildAutomationEmailPayload,
  renderTemplate,
  sendCampaign,
  sendTestEmail,
  sendAutomationEmail,
  sendTransactionalEmail,
};
