const { google } = require("googleapis");
const cron = require("node-cron");
const https = require("https");
const http = require("http");
require("dotenv").config();

// ==============================
// ENV VARIABLES
// ==============================

const SHEET_URL = process.env.SHEET_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SHEET_RANGE = process.env.SHEET_RANGE || "Sheet1!A:Z";

if (!SHEET_URL) throw new Error("SHEET_URL missing");
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID) throw new Error("CHAT_ID missing");

// Extract Sheet ID safely from both full URLs and raw IDs
function extractSheetId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  const match = trimmed.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match?.[1]) return match[1];

  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

const SHEET_ID = extractSheetId(SHEET_URL);

if (!SHEET_ID) {
  throw new Error(
    "Invalid SHEET_URL. Provide full Google Sheet URL or a valid spreadsheet ID."
  );
}

// ==============================
// GOOGLE CREDENTIALS FROM ENV
// ==============================

// Try to parse GOOGLE_CREDENTIALS if provided as a single JSON string
let credentials;

if (process.env.GOOGLE_CREDENTIALS) {
  try {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    console.log("Loaded credentials from GOOGLE_CREDENTIALS env var.");
  } catch (e) {
    console.error("Failed to parse GOOGLE_CREDENTIALS:", e.message);
  }
}

if (!credentials) {
  credentials = {
    type: process.env.type,
    project_id: process.env.project_id,
    private_key_id: process.env.private_key_id,
    private_key: process.env.private_key
      ? process.env.private_key.replace(/\\n/g, "\n")
      : undefined,
    client_email: process.env.client_email,
    client_id: process.env.client_id,
    auth_uri: process.env.auth_uri,
    token_uri: process.env.token_uri,
    auth_provider_x509_cert_url: process.env.auth_provider_x509_cert_url,
    client_x509_cert_url: process.env.client_x509_cert_url,
    universe_domain: process.env.universe_domain,
  };
}

if (!credentials.private_key) {
  throw new Error("Google private_key missing");
}

// Log which credentials loaded (without exposing secrets)
console.log("Credentials loaded for:", credentials.client_email);
console.log("Project:", credentials.project_id);

// ==============================
// MAIN FUNCTION
// ==============================

async function main() {
  try {
    console.log("Running routine...");

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
      ],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log("No data found in sheet.");
      return;
    }

    const headers = rows[0];
    const todayIndex = new Date().getDay();

    const days = [
      "Sunday","Monday","Tuesday",
      "Wednesday","Thursday","Friday","Saturday"
    ];

    const today = days[todayIndex];
    const dateStr = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    let finalMessage = `📅 ${today}, ${dateStr}\n\n`;

    let hasData = false;

    for (let i = 1; i < rows.length; i++) {
      const rowDay = (rows[i][0] || "").trim().toLowerCase();
      if (rowDay === today.toLowerCase()) {
        hasData = true;

        for (let j = 1; j < headers.length; j++) {
          if (rows[i][j]) {
            finalMessage += `${headers[j]}: ${rows[i][j]}\n\n`;
          }
        }
      }
    }

    if (!hasData) {
      finalMessage += "No classes scheduled today.";
    }

    if (!finalMessage.trim()) {
      finalMessage = "No class schedule found for today.";
    }

    console.log("Sending to Telegram...");

    const data = JSON.stringify({
      chat_id: CHAT_ID,
      text: finalMessage,
    });

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";

      res.on("data", (chunk) => {
        body += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("Message sent successfully!");
        } else {
          console.error("Telegram Error:", body);
        }
      });
    });

    req.on("error", (error) => {
      console.error("Request Error:", error);
    });

    req.write(data);
    req.end();

  } catch (error) {
    const details = error?.response?.data || error?.message || String(error);
    console.error("Error reading/sending routine:", details);
    console.error(
      "Hints: ensure the sheet is shared with service account email, SHEET_RANGE is correct, and credentials are valid."
    );
  }
}

// ==============================
// SCHEDULE: 8:00 AM BANGLADESH TIME ONLY
// ==============================

cron.schedule(
  "02 11 * * *",
  () => {
    console.log("Running scheduled routine (8AM Bangladesh)...");
    main();
  },
  {
    timezone: "Asia/Dhaka",
  }
);

// ==============================
// HTTP SERVER (required for Railway)
// ==============================

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/test") {
    main();
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Message triggered manually!");
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running. Scheduled for 8:00 AM Bangladesh time.");
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Bot running. Scheduled for 8:00 AM Bangladesh time.");
  // Send message immediately on deploy to verify it works
  console.log("Sending initial message on startup...");
  main();
});

