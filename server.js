const { google } = require("googleapis");
const cron = require("node-cron");
const fetch = require("node-fetch"); // must be v2
require("dotenv").config();

// ==============================
// ENV VARIABLES
// ==============================

const SHEET_URL = process.env.SHEET_URL;
const TODO_SHEET_URL = process.env.TODO_SHEET_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Google credentials (separate Railway vars)
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

// ==============================
// VALIDATION
// ==============================

if (!SHEET_URL) throw new Error("SHEET_URL is missing");
if (!TODO_SHEET_URL) throw new Error("TODO_SHEET_URL is missing");
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!CHAT_ID) throw new Error("CHAT_ID is missing");
if (!credentials.private_key) throw new Error("Google private_key missing");

const SHEET_ID = SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];
const TODO_SHEET_ID = TODO_SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

async function main() {
  try {
    console.log("Running routine...");

    // ==============================
    // GOOGLE AUTH
    // ==============================

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
      ],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // ==============================
    // READ CLASS SHEET
    // ==============================

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1",
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log("No class data found.");
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
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
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
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
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

      if (todayClasses.length === 0) {
        finalMessage = `📅 ${today}, ${dateStr}\n\nNo classes scheduled today.`;
      } else {
        const classList = todayClasses
          .map((cls, i) => `${i + 1}. ${cls}`)
          .join("\n\n");

        finalMessage = `📅 ${today}, ${dateStr}

Here is your class schedule:

${classList}`;
      }
    }

    // ==============================
    // SEND TO TELEGRAM
    // ==============================

    console.log("Sending to Telegram...");

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: finalMessage,
        }),
      }
    );

    const result = await telegramResponse.json();

    if (!telegramResponse.ok) {
      console.error("Telegram Error:", result);
    } else {
      console.log("Message sent successfully!");
    }

  } catch (error) {
    console.error("Error:", error.message);
  }
}

// Run immediately
main();

// Run daily at 8 AM UTC
cron.schedule("0 8 * * *", () => {
  console.log("Running scheduled routine...");
  main();
});

console.log("Bot running on Railway...");
