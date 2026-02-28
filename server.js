const { google } = require("googleapis");
const cron = require("node-cron");
const fetch = require("node-fetch");
require("dotenv").config();

// ==============================
// ENV VARIABLES
// ==============================

const SHEET_URL = process.env.SHEET_URL;
const TODO_SHEET_URL = process.env.TODO_SHEET_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

// ==============================
// VALIDATION
// ==============================

if (!SHEET_URL) throw new Error("SHEET_URL is missing");
if (!TODO_SHEET_URL) throw new Error("TODO_SHEET_URL is missing");
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!CHAT_ID) throw new Error("CHAT_ID is missing");
if (!GOOGLE_CREDENTIALS_JSON) throw new Error("GOOGLE_CREDENTIALS_JSON is missing");

// Extract Sheet IDs
const SHEET_ID = SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];
const TODO_SHEET_ID = TODO_SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

async function main() {
  try {
    console.log("Running routine...");

    // ==============================
    // GOOGLE AUTH (FROM ENV JSON)
    // ==============================

    const credentials = JSON.parse(GOOGLE_CREDENTIALS_JSON);

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
      return { colIndex: i + 1, slotName: parts[0] || "", time: parts[1] || "" };
    });

    const dayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    const dayGroups = {};
    let currentDay = null;

    for (let i = 1; i < rows.length; i++) {
      const firstCell = (rows[i][0] || "").trim().toLowerCase();
      if (dayNames.includes(firstCell)) {
        currentDay = firstCell;
        if (!dayGroups[currentDay]) dayGroups[currentDay] = [];
      }
      if (currentDay) {
        dayGroups[currentDay].push(rows[i]);
      }
    }

    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const today = days[new Date().getDay()];
    const todayRows = dayGroups[today.toLowerCase()] || [];

    const dateStr = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    let finalMessage = "";
    let hasClasses = false;

    if (todayRows.length === 0) {
      finalMessage = `Today is ${today}, ${dateStr}. No classes scheduled for today.`;
    } else {
      const todayClasses = [];

      slots.forEach((slot) => {
        for (const row of todayRows) {
          const value = (row[slot.colIndex] || "").trim();
          if (value) {
            const clean = value.split("\n").map(s => s.trim()).filter(Boolean).join(", ");
            todayClasses.push(`${slot.slotName} > ${slot.time}: ${clean}`);
            break;
          }
        }
      });

      if (todayClasses.length === 0) {
        finalMessage = `Today is ${today}, ${dateStr}. No classes scheduled for today.`;
      } else {
        hasClasses = true;
        const classList = todayClasses
          .map((cls, i) => `${i + 1}. ${cls}`)
          .join("\n\n");

        finalMessage =
`📅 ${today}, ${dateStr}

Here is your class schedule:

${classList}`;
      }
    }

    // ==============================
    // READ TODO SHEET
    // ==============================

    const todoResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: TODO_SHEET_ID,
      range: "Sheet1",
    });

    const todoRows = todoResponse.data.values;
    let hasTodos = false;

    if (todoRows && todoRows.length > 1) {
      const headers = todoRows[0];
      const tasks = todoRows.slice(1).map(row => {
        const obj = {};
        headers.forEach((h, i) => obj[h] = row[i] || "");
        return obj;
      });

      if (tasks.length > 0) {
        hasTodos = true;

        const todoList = tasks.map((t, i) => {
          let item = `${i + 1}. ${t["Task"]}`;
          if (t["Note"]) item += ` (${t["Note"]})`;
          if (t["Date"]) {
            const d = new Date(t["Date"]);
            item += ` - ${d.toLocaleDateString("en-US")}`;
          }
          return item;
        }).join("\n\n");

        finalMessage += `\n\n📝 To-Do List:\n\n${todoList}`;
      }
    }

    if (!hasClasses && !hasTodos) {
      finalMessage = `Today is ${today}, ${dateStr}. No classes and no tasks today. Enjoy your day!`;
    }

    console.log("Sending message...");

    // ==============================
    // SEND TO TELEGRAM
    // ==============================

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

// Schedule daily at 8 AM UTC
cron.schedule("0 8 * * *", () => {
  console.log("Running scheduled task...");
  main();
});

console.log("Bot running on Railway...");
