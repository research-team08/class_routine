const { google } = require("googleapis");
const cron = require("node-cron");
const https = require("https");
require("dotenv").config();

// ==============================
// ENV VARIABLES
// ==============================

const SHEET_URL = process.env.SHEET_URL;
const TODO_SHEET_URL = process.env.TODO_SHEET_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!SHEET_URL) throw new Error("SHEET_URL missing");
if (!TODO_SHEET_URL) throw new Error("TODO_SHEET_URL missing");
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!CHAT_ID) throw new Error("CHAT_ID missing");

// Extract Sheet IDs
const SHEET_ID = SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];
const TODO_SHEET_ID = TODO_SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

// ==============================
// GOOGLE CREDENTIALS FROM ENV
// ==============================

const credentials = {
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

if (!credentials.private_key) {
  throw new Error("Google private_key missing");
}

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
      range: "Sheet1",
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log("No data found.");
      return;
    }

    const headers = rows[0];
    const slots = headers.slice(1).map((header, i) => {
      const parts = header.split("\n").map((s) => s.trim());
      return {
        colIndex: i + 1,
        slotName: parts[0] || "",
        time: parts[1] || "",
      };
    });

    const dayNames = [
      "sunday","monday","tuesday",
      "wednesday","thursday","friday","saturday"
    ];

    const dayGroups = {};
    let currentDay = null;

    for (let i = 1; i < rows.length; i++) {
      const firstCell = (rows[i][0] || "").trim().toLowerCase();
      if (dayNames.includes(firstCell)) {
        currentDay = firstCell;
        if (!dayGroups[currentDay]) dayGroups[currentDay] = [];
      }
      if (currentDay) dayGroups[currentDay].push(rows[i]);
    }

    const days = [
      "Sunday","Monday","Tuesday",
      "Wednesday","Thursday","Friday","Saturday"
    ];

    const today = days[new Date().getDay()];
    const todayRows = dayGroups[today.toLowerCase()] || [];

    const dateStr = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    let finalMessage = "";

    if (todayRows.length === 0) {
      finalMessage = `📅 ${today}, ${dateStr}\n\nNo classes scheduled today.`;
    } else {
      const todayClasses = [];

      slots.forEach((slot) => {
        for (const row of todayRows) {
          const value = (row[slot.colIndex] || "").trim();
          if (value) {
            const clean = value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
              .join(", ");
            todayClasses.push(
              `${slot.slotName} > ${slot.time}: ${clean}`
            );
            break;
          }
        }
      });

      const classList = todayClasses
        .map((cls, i) => `${i + 1}. ${cls}`)
        .join("\n\n");

      finalMessage = `📅 ${today}, ${dateStr}

Here is your class schedule:

${classList}`;
    }

    // ==============================
    // SEND TO TELEGRAM (NO FETCH)
    // ==============================

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
        "Content-Length": data.length,
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
    console.error("Error:", error.message);
  }
}

// Run once on deploy
main();

// ==============================
// SCHEDULE: 8 AM BANGLADESH TIME
// ==============================

cron.schedule(
  "0 8 * * *",
  () => {
    console.log("Running scheduled routine (Asia/Dhaka 8AM)...");
    main();
  },
  {
    timezone: "Asia/Dhaka",
  }
);

console.log("Bot running on Railway (8AM Bangladesh time)...");
