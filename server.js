const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
require("dotenv").config();

// ==============================
// CONFIGURATION (from .env)
// ==============================

const GOOGLE_CREDENTIALS_FILE = process.env.GOOGLE_CREDENTIALS_FILE || "credentials.json";
const SHEET_URL = process.env.SHEET_URL;
const TODO_SHEET_URL = process.env.TODO_SHEET_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Extract spreadsheet IDs from the URLs
if (!SHEET_URL) {
  throw new Error('SHEET_URL environment variable is not set.');
}
const sheetMatch = SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/);
if (!sheetMatch) {
  throw new Error('Invalid SHEET_URL format. Could not extract Sheet ID.');
}
const SHEET_ID = sheetMatch[1];

if (!TODO_SHEET_URL) {
  throw new Error('TODO_SHEET_URL environment variable is not set.');
}
const todoSheetMatch = TODO_SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/);
if (!todoSheetMatch) {
  throw new Error('Invalid TODO_SHEET_URL format. Could not extract Sheet ID.');
}
const TODO_SHEET_ID = todoSheetMatch[1];

async function main() {
  try {
    // ==============================
    // READ GOOGLE SHEET
    // ==============================


    // Read Google credentials ONLY from environment variable (as JSON string)
    if (!process.env.GOOGLE_CREDENTIALS_JSON) {
      throw new Error('GOOGLE_CREDENTIALS_JSON environment variable is not set.');
    }
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://spreadsheets.google.com/feeds",
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
      console.log("No data found in the sheet.");
      return;
    }

    // Parse headers: extract slot name and time from each column header
    const headers = rows[0];
    const slots = headers.slice(1).map((header, i) => {
      const parts = header.split("\n").map((s) => s.trim());
      return { colIndex: i + 1, slotName: parts[0] || "", time: parts[1] || "" };
    });
          const creds = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'credentials.json'), 'utf8'));
    // Group rows by day (each day spans multiple rows; day name only in first row)
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
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

    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const today = days[new Date().getDay()];
    const todayKey = today.toLowerCase();
    const todayRows = dayGroups[todayKey] || [];

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
      // Merge all rows for today: for each slot, pick the first non-empty cell
      const slotData = {};
      slots.forEach((slot) => {
        for (const row of todayRows) {
          const cellValue = (row[slot.colIndex] || "").trim();
          if (cellValue) {
            slotData[slot.colIndex] = { slot, cellValue };
            break;
          }
        }
      });

      const todayClasses = [];
      slots.forEach((slot) => {
        const entry = slotData[slot.colIndex];
        if (entry) {
          const info = entry.cellValue.split("\n").map((s) => s.trim()).filter(Boolean).join(", ");
          todayClasses.push(`${slot.slotName} > ${slot.time}: ${info}`);
        }
      });

      if (todayClasses.length === 0) {
        finalMessage = `Today is ${today}, ${dateStr}. No classes scheduled for today.`;
      } else {
        hasClasses = true;
        const classList = todayClasses
          .map((cls, i) => `${i + 1}. ${cls}`)
          .join("\n\n");
        finalMessage = `Today is ${today}, ${dateStr}. Here is your class schedule for today:\n\n${classList}`;
      }
    }

    // ==============================
    // READ TO-DO LIST
    // ==============================

    const todoResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: TODO_SHEET_ID,
      range: "Sheet1",
    });

    const todoRows = todoResponse.data.values;
    let todoText = "";
    let hasTodos = false;

    if (todoRows && todoRows.length > 1) {
      const todoHeaders = todoRows[0];
      const todos = todoRows.slice(1).map((row) => {
        const obj = {};
        todoHeaders.forEach((h, i) => {
          obj[h] = row[i] || "";
        });
        return obj;
      });

      if (todos.length > 0) {
        hasTodos = true;
        const todoList = todos
          .map((t, i) => {
            let item = `${i + 1}. ${t["Task"]}`;
            if (t["Note"]) item += ` (${t["Note"]})`;
            if (t["Date"]) {
              const d = new Date(t["Date"]);
              const formatted = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
              item += ` - Date: ${formatted}`;
            }
            return item;
          })
          .join("\n\n");
        todoText = `\n\n\u{1F4DD} To-Do List:\n\n${todoList}`;
      }
    }

    // Build final message
    if (!hasClasses && !hasTodos) {
      finalMessage = `Today is ${today}, ${dateStr}. No classes and no tasks for today. Enjoy your day!`;
    } else {
      finalMessage += todoText;
    }

    console.log("Message:\n" + finalMessage);

    // ==============================
    // SEND TO TELEGRAM
    // ==============================

    const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    const telegramResponse = await fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: finalMessage,
      }),
    });

    const telegramResult = await telegramResponse.json();
    if (telegramResponse.ok) {
      console.log("Message sent successfully!");
    } else {
      console.error("Failed to send message:", JSON.stringify(telegramResult));
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

// Run once immediately on start
main();

// Then run every day at 8:00 AM
cron.schedule("0 8 * * *", () => {
  console.log(`[${new Date().toLocaleString()}] Running scheduled routine...`);
  main();
});

console.log("Bot is running. Scheduled to send at 8:00 AM daily.");
