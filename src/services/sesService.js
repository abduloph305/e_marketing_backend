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

const rewriteTrackedLinks = (html, clickTrackingUrl) => {
  if (!clickTrackingUrl) {
    return html;
  }

  return html.replace(
    /<a\b([^>]*?)href=(["'])(.*?)\2([^>]*?)>/gi,
    (_match, before, quote, href, after) => {
      const trimmedHref = href.trim();

      if (
        !trimmedHref ||
        trimmedHref.startsWith("#") ||
        trimmedHref.startsWith("mailto:") ||
        trimmedHref.startsWith("tel:") ||
        trimmedHref.startsWith("javascript:")
      ) {
        return `<a${before}href=${quote}${href}${quote}${after}>`;
      }

      const redirected = `${clickTrackingUrl}?url=${encodeURIComponent(trimmedHref)}`;
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
}) => {
  if (!fromEmail) {
    throw new Error("Transactional sender email is missing");
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
