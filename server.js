const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const cron = require("node-cron");
const { google } = require("googleapis");

require("dotenv").config();

const SHEET_URL         = process.env.SHEET_URL;
const TODO_SHEET_URL    = process.env.TODO_SHEET_URL;
const BOT_TOKEN         = process.env.BOT_TOKEN;
const CHAT_ID           = process.env.CHAT_ID;
const SHEET_RANGE       = process.env.SHEET_RANGE || "Sheet1!A:Z";
const TODO_SHEET_RANGE  = process.env.TODO_SHEET_RANGE || "Sheet1!A:Z";
const TEST_TRIGGER_TOKEN = process.env.TEST_TRIGGER_TOKEN;

if (!SHEET_URL) throw new Error("SHEET_URL missing.");
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing.");
if (!CHAT_ID)   throw new Error("CHAT_ID missing.");

const DAYS = [
  "Sunday", "Monday", "Tuesday",
  "Wednesday", "Thursday", "Friday", "Saturday",
];

function extractSheetId(input) {
  if (!input) return null;
  const trimmed = input.trim();

  const match = trimmed.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match?.[1]) return match[1];

  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;

  return null;
}

const SHEET_ID      = extractSheetId(SHEET_URL);
const TODO_SHEET_ID = extractSheetId(TODO_SHEET_URL);

if (!SHEET_ID) {
  throw new Error(
    "Invalid SHEET_URL. Provide a full Google Sheet URL or a valid spreadsheet ID."
  );
}

if (TODO_SHEET_URL && !TODO_SHEET_ID) {
  console.warn("Warning: TODO_SHEET_URL provided but invalid. To-do feature disabled.");
}

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
  const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_FILE);
  if (fs.existsSync(credPath)) {
    try {
      credentials = JSON.parse(fs.readFileSync(credPath, "utf8"));
      console.log("Loaded credentials from file:", credPath);
    } catch (e) {
      console.error("Failed to parse GOOGLE_CREDENTIALS_FILE:", e.message);
    }
  } else {
    console.warn("GOOGLE_CREDENTIALS_FILE not found, skipping:", credPath);
  }
}

if (!credentials) {
  const localCredPath = path.join(__dirname, "credentials.json");
  if (fs.existsSync(localCredPath)) {
    try {
      credentials = JSON.parse(fs.readFileSync(localCredPath, "utf8"));
      console.log("Loaded credentials from local credentials.json file.");
    } catch (e) {
      console.error("Failed to load local credentials.json:", e.message);
    }
  }
}

if (!credentials) {
  const pk = process.env.GOOGLE_PRIVATE_KEY || process.env.private_key;
  credentials = {
    type:                        process.env.GOOGLE_TYPE || process.env.type,
    project_id:                  process.env.GOOGLE_PROJECT_ID || process.env.project_id,
    private_key_id:              process.env.GOOGLE_PRIVATE_KEY_ID || process.env.private_key_id,
    private_key:                 pk ? pk.replace(/\\n/g, "\n") : undefined,
    client_email:                process.env.GOOGLE_CLIENT_EMAIL || process.env.client_email,
    client_id:                   process.env.GOOGLE_CLIENT_ID || process.env.client_id,
    auth_uri:                    process.env.GOOGLE_AUTH_URI || process.env.auth_uri,
    token_uri:                   process.env.GOOGLE_TOKEN_URI || process.env.token_uri,
    auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL || process.env.auth_provider_x509_cert_url,
    client_x509_cert_url:        process.env.GOOGLE_CLIENT_X509_CERT_URL || process.env.client_x509_cert_url,
    universe_domain:             process.env.GOOGLE_UNIVERSE_DOMAIN || process.env.universe_domain,
  };
}

if (!credentials.private_key || !credentials.client_email || !credentials.project_id) {
  throw new Error(
    "Google credentials incomplete. Provide GOOGLE_CREDENTIALS JSON or the required env fields."
  );
}

console.log("Credentials loaded for:", credentials.client_email);
console.log("Project:", credentials.project_id);

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

    const MONTHS = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const now       = new Date();
    const today     = DAYS[now.getDay()];
    const dateStr   = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

    let finalMessage = `Today is ${today}, ${dateStr}.\n\n`;

    finalMessage += buildClassSchedule(
      await fetchSheetData(sheets, SHEET_ID, SHEET_RANGE),
      today
    );

    if (TODO_SHEET_ID) {
      finalMessage += buildTodoList(
        await fetchSheetData(sheets, TODO_SHEET_ID, TODO_SHEET_RANGE)
      );
    }

    await sendTelegramMessage(finalMessage);

  } catch (error) {
    const details = error?.response?.data || error?.message || String(error);
    console.error("Error reading/sending routine:", details);
    console.error(
      "Hint: ensure the sheets are shared with the service-account email and that ranges are correct."
    );
  }
}

async function fetchSheetData(sheets, spreadsheetId, range) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return response.data.values;
}

function buildClassSchedule(rows, today) {
  let section = "Class Schedule:\n---------------\n";

  if (!rows || rows.length === 0) {
    return section + "No classes scheduled for today.\n\n";
  }

  const headers        = rows[0];
  const classesForToday = [];
  let inTodaySection    = false;

  for (let i = 1; i < rows.length; i++) {
    const rowDay         = (rows[i][0] || "").trim().toLowerCase();
    const isNewDayMarker = DAYS.some((d) => d.toLowerCase() === rowDay);

    if (isNewDayMarker) {
      inTodaySection = rowDay === today.toLowerCase();
    }

    if (!inTodaySection) continue;

    for (let j = 1; j < headers.length; j++) {
      if (!rows[i][j]) continue;

      const headerParts = headers[j].split("\n");
      const slotName    = headerParts[0]?.trim() || "";
      const timeSlot    = headerParts[1]?.trim() || "";

      const lines = String(rows[i][j])
        .trim()
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      classesForToday.push({
        slotNum:    j,
        slotName,
        timeSlot,
        teacher:    lines[0] || "",
        courseCode:  lines[1] || "",
        room:       lines[2] || "",
      });
    }
  }

  if (classesForToday.length === 0) {
    return section + "No classes scheduled for today.\n\n";
  }

  classesForToday.sort((a, b) => a.slotNum - b.slotNum);

  classesForToday.forEach((cls, idx) => {
    section += `${idx + 1}. ${cls.slotName} > ${cls.timeSlot}\n`;
    section += `${cls.teacher}, ${cls.courseCode}, ${cls.room}\n\n`;
  });

  return section;
}

function buildTodoList(rows) {
  let section = "TO-DO List:\n---------------\n";

  if (!rows || rows.length <= 1) {
    return section + "No pending tasks.\n";
  }

  let taskNumber = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const task    = row[0] ? String(row[0]).trim() : "";
    const note    = row[1] ? String(row[1]).trim() : "";
    const rawDate = row[2] ? String(row[2]).trim() : "";

    if (!task) continue;

    taskNumber++;
    section += `${taskNumber}. ${task}\n`;
    if (note)    section += `   Note: ${note}\n`;
    if (rawDate) {
      const MONTHS = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];
      const parsed = new Date(rawDate);
      const dueDate = isNaN(parsed.getTime())
        ? rawDate
        : `${MONTHS[parsed.getMonth()]} ${parsed.getDate()}, ${parsed.getFullYear()}`;
      section += `   Date: ${dueDate}\n`;
    }
    section += "\n";
  }

  if (taskNumber === 0) {
    section += "No pending tasks.\n";
  }

  return section;
}

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    console.log("Sending to Telegram...");

    const payload = JSON.stringify({ chat_id: CHAT_ID, text });

    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length":  Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("Message sent successfully!");
          resolve(body);
        } else {
          console.error("Telegram Error:", body);
          reject(new Error(`Telegram responded with status ${res.statusCode}`));
        }
      });
    });

    req.on("error", (error) => {
      console.error("Request Error:", error);
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

cron.schedule(
  "41 14 * * *",
  () => {
    console.log("Running scheduled routine (8:00 AM Bangladesh)...");
    main();
  },
  { timezone: "Asia/Dhaka" }
);

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/test") {
    if (TEST_TRIGGER_TOKEN) {
      const authHeader = req.headers["authorization"] || "";
      if (authHeader !== `Bearer ${TEST_TRIGGER_TOKEN}`) {
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
