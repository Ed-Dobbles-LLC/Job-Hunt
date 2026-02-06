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

  const rawResponse = await fetch(
    "https://" +
      hostname +
      "/api/v2/connection?include_secrets=true&connector_names=google-mail",
    {
      headers: {
        Accept: "application/json",
        X_REPLIT_TOKEN: xReplitToken,
      },
    },
  );
  const data = await rawResponse.json();
  connectionSettings = data.items?.[0];

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

function getDirectGmailClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export interface RawEmail {
  id: string;
  subject: string;
  from: string;
  date: string;
  body: string;
}

function extractBodyFromPayload(payload: any): string {
  let body = "";
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
      if (part.parts) {
        const nested = extractBodyFromPayload(part);
        if (nested) {
          body = nested;
          if (part.mimeType?.includes("text/plain")) break;
        }
      }
    }
  }
  return body;
}

async function fetchMessagesFromGmail(
  gmail: any,
  query: string,
  maxResults: number,
  markRead: boolean = false,
): Promise<RawEmail[]> {
  const listResponse = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: query,
  });

  const messageIds = listResponse.data.messages || [];
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
      const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
      const from = headers.find((h: any) => h.name === "From")?.value || "Unknown";
      const date = headers.find((h: any) => h.name === "Date")?.value || new Date().toISOString();
      const body = extractBodyFromPayload(full.data.payload);

      emails.push({ id: msg.id!, subject, from, date, body });

      if (markRead) {
        try {
          await gmail.users.messages.modify({
            userId: "me",
            id: msg.id!,
            requestBody: { removeLabelIds: ["UNREAD"] },
          });
        } catch (modErr) {
          console.log(`📧 [Gmail] Could not mark ${msg.id} as read (readonly scope)`);
        }
      }
    } catch (err) {
      console.error(`Failed to fetch message ${msg.id}:`, err);
    }
  }
  return emails;
}

export async function fetchEmailsFromLabel(
  labelName: string,
  maxResults: number = 20,
): Promise<RawEmail[]> {
  const directGmail = getDirectGmailClient();

  if (directGmail) {
    console.log(`📧 [Gmail] Using direct Google Cloud API credentials`);
    try {
      const labelsResponse = await directGmail.users.labels.list({ userId: "me" });
      const labels = labelsResponse.data.labels || [];
      const targetLabel = labels.find(
        (l) => l.name?.toUpperCase() === labelName.toUpperCase(),
      );

      if (targetLabel) {
        console.log(`📧 [Gmail] Found label "${labelName}" (${targetLabel.id})`);
        const labelResponse = await directGmail.users.messages.list({
          userId: "me",
          labelIds: [targetLabel.id!],
          maxResults,
        });
        const labelMsgIds = labelResponse.data.messages || [];
        console.log(`📧 [Gmail] Found ${labelMsgIds.length} emails in label "${labelName}"`);
        if (labelMsgIds.length > 0) {
          const labelEmails: RawEmail[] = [];
          for (const msg of labelMsgIds) {
            try {
              const full = await directGmail.users.messages.get({
                userId: "me",
                id: msg.id!,
                format: "full",
              });
              const headers = full.data.payload?.headers || [];
              const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
              const from = headers.find((h: any) => h.name === "From")?.value || "Unknown";
              const date = headers.find((h: any) => h.name === "Date")?.value || new Date().toISOString();
              const body = extractBodyFromPayload(full.data.payload);
              labelEmails.push({ id: msg.id!, subject, from, date, body });
            } catch (err) {
              console.error(`Failed to fetch message ${msg.id}:`, err);
            }
          }
          if (labelEmails.length > 0) {
            console.log(`📧 [Gmail] Fetched ${labelEmails.length} emails from label "${labelName}"`);
            return labelEmails;
          }
        }
      } else {
        console.log(
          `📧 [Gmail] Label "${labelName}" not found. Available: ${labels.map((l) => l.name).join(", ")}`,
        );
      }

      console.log(`📧 [Gmail] Searching for LinkedIn job alert emails`);
      const searchQuery = 'from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR indeed.com) subject:(job OR jobs OR alert) is:unread';
      const searchEmails = await fetchMessagesFromGmail(directGmail, searchQuery, maxResults, false);

      if (searchEmails.length > 0) {
        console.log(`📧 [Gmail] Found ${searchEmails.length} job alert emails via search`);
        return searchEmails;
      }

      const recentQuery = 'from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR indeed.com) newer_than:3d';
      const recentEmails = await fetchMessagesFromGmail(directGmail, recentQuery, maxResults, false);
      if (recentEmails.length > 0) {
        console.log(`📧 [Gmail] Found ${recentEmails.length} recent job alert emails (last 3 days)`);
        return recentEmails;
      }

      console.log(`📧 [Gmail] No job alert emails found via direct API`);
      return [];
    } catch (err: any) {
      console.error(`📧 [Gmail] Direct API error: ${err.message}`);
      console.log(`📧 [Gmail] Falling back to Replit connector`);
    }
  }

  console.log(`📧 [Gmail] Using Replit connector (addon scopes)`);
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
    const searchQuery = 'from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR indeed.com) subject:(job OR jobs OR alert) is:unread';
    return fetchMessagesFromGmail(gmail, searchQuery, maxResults, true);
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
      const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
      const from = headers.find((h: any) => h.name === "From")?.value || "Unknown";
      const date = headers.find((h: any) => h.name === "Date")?.value || new Date().toISOString();
      const body = extractBodyFromPayload(full.data.payload);
      emails.push({ id: msg.id!, subject, from, date, body });

      await gmail.users.messages.modify({
        userId: "me",
        id: msg.id!,
        requestBody: { removeLabelIds: ["UNREAD"] },
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
