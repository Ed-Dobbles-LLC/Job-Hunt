import { google } from "googleapis";

let connectionSettings: any;

async function getAccessToken() {
  if (
    connectionSettings &&
    connectionSettings.settings.expires_at &&
    new Date(connectionSettings.settings.expires_at).getTime() > Date.now()
  ) {
    return connectionSettings.settings.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("X_REPLIT_TOKEN not found for repl/depl");
  }

  connectionSettings = await fetch(
    "https://" +
      hostname +
      "/api/v2/connection?include_secrets=true&connector_names=google-mail",
    {
      headers: {
        Accept: "application/json",
        X_REPLIT_TOKEN: xReplitToken,
      },
    },
  )
    .then((res) => res.json())
    .then((data) => data.items?.[0]);

  const accessToken =
    connectionSettings?.settings?.access_token ||
    connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error("Gmail not connected");
  }
  return accessToken;
}

export async function getUncachableGmailClient() {
  const accessToken = await getAccessToken();

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken,
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export interface RawEmail {
  id: string;
  subject: string;
  from: string;
  date: string;
  body: string;
}

export async function fetchEmailsFromLabel(
  labelName: string,
  maxResults: number = 20,
): Promise<RawEmail[]> {
  const gmail = await getUncachableGmailClient();

  const labelsResponse = await gmail.users.labels.list({ userId: "me" });
  const labels = labelsResponse.data.labels || [];
  const targetLabel = labels.find(
    (l) => l.name?.toUpperCase() === labelName.toUpperCase(),
  );

  if (!targetLabel) {
    console.log(
      `📧 Label "${labelName}" not found. Available labels: ${labels.map((l) => l.name).join(", ")}`,
    );
    console.log(
      `📧 Falling back to search for LinkedIn job alert emails`,
    );
    const fallbackResponse = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      q: 'from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR indeed.com) subject:(job OR jobs OR alert) is:unread',
    });
    const fallbackIds = fallbackResponse.data.messages || [];
    if (fallbackIds.length === 0) {
      console.log(`📧 No job alert emails found via search fallback either`);
      return [];
    }
    console.log(`📧 Found ${fallbackIds.length} job alert emails via search fallback`);
    const fallbackEmails: RawEmail[] = [];
    for (const msg of fallbackIds) {
      try {
        const full = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "full",
        });
        const headers = full.data.payload?.headers || [];
        const subject = headers.find((h) => h.name === "Subject")?.value || "No Subject";
        const from = headers.find((h) => h.name === "From")?.value || "Unknown";
        const date = headers.find((h) => h.name === "Date")?.value || new Date().toISOString();
        let body = "";
        const payload = full.data.payload;
        if (payload?.body?.data) {
          body = Buffer.from(payload.body.data, "base64").toString("utf-8");
        } else if (payload?.parts) {
          for (const part of payload.parts) {
            if (part.mimeType === "text/plain" && part.body?.data) {
              body = Buffer.from(part.body.data, "base64").toString("utf-8");
              break;
            }
            if (part.mimeType === "text/html" && part.body?.data) {
              body = Buffer.from(part.body.data, "base64").toString("utf-8");
              body = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
            }
          }
        }
        fallbackEmails.push({ id: msg.id!, subject, from, date, body });
        await gmail.users.messages.modify({
          userId: "me",
          id: msg.id!,
          requestBody: { removeLabelIds: ["UNREAD"] },
        });
      } catch (err) {
        console.error(`Failed to fetch message ${msg.id}:`, err);
      }
    }
    return fallbackEmails;
  }

  const messagesResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: [targetLabel.id!],
    maxResults,
    q: "is:unread",
  });

  const messageIds = messagesResponse.data.messages || [];
  if (messageIds.length === 0) {
    return [];
  }

  const emails: RawEmail[] = [];

  for (const msg of messageIds) {
    try {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "full",
      });

      const headers = full.data.payload?.headers || [];
      const subject =
        headers.find((h) => h.name === "Subject")?.value || "No Subject";
      const from =
        headers.find((h) => h.name === "From")?.value || "Unknown";
      const date =
        headers.find((h) => h.name === "Date")?.value ||
        new Date().toISOString();

      let body = "";
      const payload = full.data.payload;
      if (payload?.body?.data) {
        body = Buffer.from(payload.body.data, "base64").toString("utf-8");
      } else if (payload?.parts) {
        for (const part of payload.parts) {
          if (
            part.mimeType === "text/plain" &&
            part.body?.data
          ) {
            body = Buffer.from(part.body.data, "base64").toString("utf-8");
            break;
          }
          if (
            part.mimeType === "text/html" &&
            part.body?.data
          ) {
            body = Buffer.from(part.body.data, "base64").toString("utf-8");
            body = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          }
        }
      }

      emails.push({
        id: msg.id!,
        subject,
        from,
        date,
        body,
      });

      await gmail.users.messages.modify({
        userId: "me",
        id: msg.id!,
        requestBody: {
          removeLabelIds: ["UNREAD"],
        },
      });
    } catch (err) {
      console.error(`Failed to fetch message ${msg.id}:`, err);
    }
  }

  return emails;
}

export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
): Promise<void> {
  const gmail = await getUncachableGmailClient();

  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/html; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    htmlBody,
  ].join("\r\n");

  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedMessage,
    },
  });
}
