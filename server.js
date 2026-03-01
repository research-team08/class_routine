const { google } = require("googleapis");
const cron = require("node-cron");
const https = require("https");
const http = require("http");
require("dotenv").config();

// ==============================
// ENV VARIABLES
// ==============================

const SHEET_URL = process.env.SHEET_URL;
const TODO_SHEET_URL = process.env.TODO_SHEET_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SHEET_RANGE = process.env.SHEET_RANGE || "Sheet1!A:Z";
const TODO_SHEET_RANGE = process.env.TODO_SHEET_RANGE || "Sheet1!A:Z";
const TEST_TRIGGER_TOKEN = process.env.TEST_TRIGGER_TOKEN;

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
const TODO_SHEET_ID = extractSheetId(TODO_SHEET_URL);

if (!SHEET_ID) {
  throw new Error(
    "Invalid SHEET_URL. Provide full Google Sheet URL or a valid spreadsheet ID."
  );
}

if (TODO_SHEET_URL && !TODO_SHEET_ID) {
  console.warn("Warning: TODO_SHEET_URL provided but invalid. To-do feature disabled.");
}

// ==============================
// GOOGLE CREDENTIALS FROM ENV
// ==============================

const fs = require("fs");
const path = require("path");

// Try to load credentials in priority order:
// 1. GOOGLE_CREDENTIALS (JSON string)
// 2. GOOGLE_CREDENTIALS_FILE (path to JSON file)
// 3. Local credentials.json file
// 4. Individual env vars (GOOGLE_PRIVATE_KEY, etc.)

let credentials;

if (process.env.GOOGLE_CREDENTIALS) {
  try {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    console.log("Loaded credentials from GOOGLE_CREDENTIALS env var.");
  } catch (e) {
    console.error("Failed to parse GOOGLE_CREDENTIALS:", e.message);
  }
}

if (!credentials && process.env.GOOGLE_CREDENTIALS_FILE) {
  try {
    const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_FILE);
    const raw = fs.readFileSync(credPath, "utf8");
    credentials = JSON.parse(raw);
    console.log("Loaded credentials from file:", credPath);
  } catch (e) {
    console.error("Failed to load GOOGLE_CREDENTIALS_FILE:", e.message);
  }
}

// Try loading from local credentials.json file
if (!credentials) {
  const localCredPath = path.join(__dirname, "credentials.json");
  if (fs.existsSync(localCredPath)) {
    try {
      const raw = fs.readFileSync(localCredPath, "utf8");
      credentials = JSON.parse(raw);
      console.log("Loaded credentials from local credentials.json file.");
    } catch (e) {
      console.error("Failed to load local credentials.json:", e.message);
    }
  }
}

if (!credentials) {
  credentials = {
    type: process.env.GOOGLE_TYPE || process.env.type,
    project_id: process.env.GOOGLE_PROJECT_ID || process.env.project_id,
    private_key_id:
      process.env.GOOGLE_PRIVATE_KEY_ID || process.env.private_key_id,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || process.env.private_key)
      ? (process.env.GOOGLE_PRIVATE_KEY || process.env.private_key).replace(
          /\\n/g,
          "\n"
        )
      : undefined,
    client_email: process.env.GOOGLE_CLIENT_EMAIL || process.env.client_email,
    client_id: process.env.GOOGLE_CLIENT_ID || process.env.client_id,
    auth_uri: process.env.GOOGLE_AUTH_URI || process.env.auth_uri,
    token_uri: process.env.GOOGLE_TOKEN_URI || process.env.token_uri,
    auth_provider_x509_cert_url:
      process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL ||
      process.env.auth_provider_x509_cert_url,
    client_x509_cert_url:
      process.env.GOOGLE_CLIENT_X509_CERT_URL ||
      process.env.client_x509_cert_url,
    universe_domain:
      process.env.GOOGLE_UNIVERSE_DOMAIN || process.env.universe_domain,
  };
}

if (!credentials.private_key || !credentials.client_email || !credentials.project_id) {
  throw new Error(
    "Google credentials incomplete. Provide GOOGLE_CREDENTIALS JSON or required env fields."
  );
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

    let finalMessage = `Today is ${today}, ${dateStr}.\n\n`;

    // ===== CLASS SCHEDULE =====
    const routineResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
      majorDimension: "ROWS",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });

    const rows = routineResponse.data.values;
    let hasClasses = false;
    
    if (rows && rows.length > 0) {
      const headers = rows[0];
      let classesForToday = [];
      let inTodaySection = false;
      
      for (let i = 1; i < rows.length; i++) {
        const rowDay = (rows[i][0] || "").trim().toLowerCase();
        const isNewDayMarker = days.some(d => d.toLowerCase() === rowDay);
        
        if (isNewDayMarker) {
          inTodaySection = (rowDay === today.toLowerCase());
        }
        
        if (inTodaySection) {
          for (let j = 1; j < headers.length; j++) {
            if (rows[i][j]) {
              hasClasses = true;
              const headerParts = headers[j].split('\n');
              const slotName = headerParts[0] ? headerParts[0].trim() : "";
              const timeSlot = headerParts[1] ? headerParts[1].trim() : "";
              
              const cellContent = String(rows[i][j]).trim();
              const lines = cellContent.split('\n').map(l => l.trim()).filter(l => l);
              
              classesForToday.push({
                slotNum: j,
                slotName,
                timeSlot,
                teacher: lines[0] || "",
                courseCode: lines[1] || "",
                room: lines[2] || ""
              });
            }
          }
        }
      }
      
      classesForToday.sort((a, b) => a.slotNum - b.slotNum);
      
      if (hasClasses) {
        finalMessage += `CLASS SCHEDULE:\n`;
        finalMessage += `---------------\n`;
        let classNumber = 0;
        for (const cls of classesForToday) {
          classNumber++;
          finalMessage += `${classNumber}. ${cls.slotName} > ${cls.timeSlot}\n`;
          finalMessage += `${cls.teacher}, ${cls.courseCode}, ${cls.room}\n\n`;
        }
      } else {
        finalMessage += `CLASS SCHEDULE:\n`;
        finalMessage += `---------------\n`;
        finalMessage += `No classes scheduled for today.\n\n`;
      }
    }

    // ===== TO-DO LIST =====
    if (TODO_SHEET_ID) {
      const todoResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: TODO_SHEET_ID,
        range: TODO_SHEET_RANGE,
        majorDimension: "ROWS",
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      });

      const todoRows = todoResponse.data.values;
      
      finalMessage += `TO-DO LIST:\n`;
      finalMessage += `---------------\n`;
      
      let hasTasks = false;
      let taskNumber = 0;
      
      if (todoRows && todoRows.length > 1) {
        for (let i = 1; i < todoRows.length; i++) {
          const row = todoRows[i];
          if (row && row.length > 0) {
            const task = row[0] ? String(row[0]).trim() : "";
            const note = row[1] ? String(row[1]).trim() : "";
            const dueDate = row[2] ? String(row[2]).trim() : "";
            
            if (task) {
              hasTasks = true;
              taskNumber++;
              finalMessage += `${taskNumber}. ${task}\n`;
              if (note) finalMessage += `   Note: ${note}\n`;
              if (dueDate) finalMessage += `   Date: ${dueDate}\n`;
              finalMessage += `\n`;
            }
          }
        }
      }
      
      if (!hasTasks) {
        finalMessage += `No pending tasks.\n`;
      }
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
      "Hints: ensure the sheets are shared with service account email and ranges are correct."
    );
  }
}

// ==============================
// SCHEDULE: 8:00 AM BANGLADESH TIME ONLY
// ==============================

cron.schedule(
  "52 11 * * *",
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
    if (TEST_TRIGGER_TOKEN) {
      const authHeader = req.headers["authorization"] || "";
      const expected = `Bearer ${TEST_TRIGGER_TOKEN}`;
      if (authHeader !== expected) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized");
        return;
      }
    }

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
});
