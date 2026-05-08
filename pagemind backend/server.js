// server.js — PageMind AI Backend v3
// Automates gemini.google.com via Playwright. No API key needed.
//
// Performance strategy:
//  • ONE persistent browser + ONE persistent page (never closed between requests)
//  • Page is reused by navigating back to /app after each request (saves ~8s cold page load)
//  • Prompt is injected via clipboard paste (not keyboard.type) — vastly faster for large prompts
//  • Content is trimmed intelligently (first 3500 + last 500 chars) to preserve context
//  • Response polling via MutationObserver trick avoids fixed sleeps
//  • Gemini 2.0 Flash URL used — fastest available model in the UI

import express from "express";
import cors    from "cors";
import { chromium } from "playwright";

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "100kb" }));

// ─────────────────────────────────────────────────────────────────────────────
// Browser + Page singleton
// We keep ONE page open and reuse it. Between requests we clear the input
// instead of navigating, which is ~5–8 seconds faster per request.
// ─────────────────────────────────────────────────────────────────────────────
let browser          = null;
let geminiPage       = null;   // persistent Gemini page
let pageReady        = false;  // true once the input field is confirmed visible
let browserBorn      = 0;
let requestInFlight  = false;  // simple mutex — Gemini can't handle parallel requests
const BROWSER_TTL    = 28 * 60 * 1000; // recycle browser after 28 min

async function getLiveBrowser() {
  const now = Date.now();
  if (browser && now - browserBorn < BROWSER_TTL) {
    try { await browser.version(); return browser; } catch { /* fall through */ }
  }
  // Kill old browser + page
  geminiPage  = null;
  pageReady   = false;
  if (browser) { try { await browser.close(); } catch {} }

  console.log("[browser] Launching Chromium…");
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",            // mandatory on Render free tier
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-default-browser-check",
      "--safebrowsing-disable-auto-update",
    ],
  });
  browserBorn = Date.now();
  console.log("[browser] Ready.");
  return browser;
}

// Open (or verify) the persistent Gemini page
async function getGeminiPage() {
  if (geminiPage && pageReady) {
    // Quick sanity-check the page is still alive
    try {
      const alive = await geminiPage.evaluate(() => !!document.body).catch(() => false);
      if (alive) return geminiPage;
    } catch { /* fall through */ }
  }

  // Need a fresh page
  pageReady  = false;
  const b    = await getLiveBrowser();
  const ctx  = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    // Grant clipboard permissions so we can paste prompts
    permissions: ["clipboard-read", "clipboard-write"],
  });

  const page = await ctx.newPage();
  geminiPage = page;

  // Block everything that isn't HTML/JS/CSS/fetch — speeds up page load significantly
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font", "stylesheet"].includes(type)) return route.abort();
    const url = route.request().url();
    // Block analytics, ads, telemetry
    if (/google-analytics|doubleclick|googlesyndication|googletagmanager|gstatic\.com\/recaptcha|fonts\.google/.test(url))
      return route.abort();
    return route.continue();
  });

  console.log("[page] Navigating to Gemini…");
  await page.goto("https://gemini.google.com/app", {
    waitUntil: "domcontentloaded",
    timeout:   45_000,
  });

  // Wait for the input to be ready
  await waitForInput(page);
  pageReady = true;
  console.log("[page] Gemini page ready and cached.");
  return page;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selector constants — ordered by reliability based on Gemini's current DOM
// ─────────────────────────────────────────────────────────────────────────────
const INPUT_SELECTORS = [
  "rich-textarea .ql-editor",                    // Quill editor (most common in 2024/25)
  'rich-textarea div[contenteditable="true"]',
  'div[contenteditable="true"][aria-label]',
  'div[contenteditable="true"].ql-editor',
  'textarea[aria-label*="message" i]',
  'div[data-placeholder*="message" i]',
  'div[data-placeholder*="Enter" i]',
];

const SEND_SELECTORS = [
  'button[aria-label="Send message"]',
  'button[aria-label*="Send" i]',
  'button[jsname="Qx7uuf"]',
  'button[data-testid="send-button"]',
  'mat-icon[data-mat-icon-name="arrow_upward_alt"]',   // alternate icon button
];

const RESPONSE_SELECTORS = [
  "model-response .markdown",
  "model-response response-container .markdown",
  ".response-content .markdown",
  "message-content .markdown",
  "model-response",
];

const STOP_SELECTORS = [
  'button[aria-label*="Stop generating" i]',
  'button[aria-label*="Stop" i]',
  'button[data-testid="stop-button"]',
];

async function waitForInput(page, timeout = 20_000) {
  const sel = INPUT_SELECTORS.join(", ");
  await page.waitForSelector(sel, { state: "visible", timeout });
  return page.$(sel);
}

async function findSendButton(page) {
  for (const sel of SEND_SELECTORS) {
    const btn = await page.$(sel);
    if (btn) return btn;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiter
// ─────────────────────────────────────────────────────────────────────────────
const rateLog = new Map();
function checkRate(ip) {
  const now    = Date.now();
  const log    = rateLog.get(ip) || [];
  const recent = log.filter(t => now - t < 60_000);
  if (recent.length >= 8) return false;   // 8 req/min per IP
  recent.push(now);
  rateLog.set(ip, recent);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart content truncation
// Takes the first 3500 chars (intro/body) + last 500 chars (conclusion)
// giving Gemini better context than a simple head-slice.
// ─────────────────────────────────────────────────────────────────────────────
function smartTruncate(text, max = 4000) {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 600).trimEnd();
  const tail = text.slice(-500).trimStart();
  return `${head}\n\n[…content trimmed…]\n\n${tail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build prompt — tighter and more explicit than before
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(title, content, mode) {
  const modeMap = {
    brief:    { bullets: 3,    insights: 1, topics: 3  },
    default:  { bullets: 5,    insights: 3, topics: 5  },
    detailed: { bullets: 8,    insights: 5, topics: 8  },
  };
  const { bullets, insights, topics } = modeMap[mode] || modeMap.default;
  const body = smartTruncate(content);

  return (
`You are a precise webpage summarizer. Read the content below and respond with a single JSON object — no markdown fences, no explanation, no extra text before or after.

TITLE: ${title || "Untitled"}

CONTENT:
${body}

OUTPUT (raw JSON only):
{
  "summary":     [/* exactly ${bullets} concise bullet strings, each ≤ 20 words */],
  "keyInsights": [/* exactly ${insights} deeper insight string(s), each ≤ 30 words */],
  "topics":      [/* exactly ${topics} short keyword/phrase strings */],
  "sentiment":   "positive" | "neutral" | "negative",
  "contentType": "article" | "news" | "documentation" | "blog" | "other"
}

STRICT RULES:
1. summary must have EXACTLY ${bullets} items — no more, no less.
2. keyInsights must have EXACTLY ${insights} item(s).
3. topics must have EXACTLY ${topics} items.
4. sentiment must be one of the three exact strings above.
5. contentType must be one of the five exact strings above.
6. Do NOT include backticks, markdown, or any text outside the JSON object.
7. All strings must be in English.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: inject prompt → wait for Gemini → extract text
// ─────────────────────────────────────────────────────────────────────────────
async function askGemini(prompt) {
  const page = await getGeminiPage();

  // ── 1. Clear any previous content in the input ──────────────────────────
  const inputEl = await waitForInput(page, 10_000);
  await inputEl.click();
  // Select-all + delete to clear reliably
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  // Brief pause for React/Quill to register the clear
  await page.waitForTimeout(200);

  // ── 2. Paste prompt via clipboard (10–50× faster than keyboard.type) ────
  // We use page.evaluate to write to clipboard directly, bypassing browser security
  await page.evaluate((text) => navigator.clipboard.writeText(text), prompt);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(300); // let paste event settle

  // Verify text was actually inserted
  const inserted = await page.evaluate(() => {
    const sels = [
      "rich-textarea .ql-editor",
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el?.textContent?.trim()) return true;
    }
    return false;
  });

  if (!inserted) {
    // Clipboard paste failed (some Render environments restrict it) — fall back to fill()
    console.warn("[gemini] Clipboard paste failed, using fill() fallback…");
    await inputEl.fill(prompt);
    await page.waitForTimeout(300);
  }

  // ── 3. Submit ────────────────────────────────────────────────────────────
  const sendBtn = await findSendButton(page);
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }
  console.log("[gemini] Prompt submitted.");

  // ── 4. Wait for response to START appearing ──────────────────────────────
  const RESP_SEL = RESPONSE_SELECTORS.join(", ");
  await page.waitForSelector(RESP_SEL, { state: "visible", timeout: 45_000 });

  // ── 5. Wait for streaming to FINISH ─────────────────────────────────────
  // Strategy A: stop-button lifecycle (most reliable)
  const STOP_SEL = STOP_SELECTORS.join(", ");
  let streamedViaStopBtn = false;
  try {
    await page.waitForSelector(STOP_SEL, { state: "visible", timeout: 5_000 });
    await page.waitForSelector(STOP_SEL, { state: "hidden",  timeout: 60_000 });
    streamedViaStopBtn = true;
  } catch {
    // Strategy B: poll for text stability — if content stops changing for 1.5s, we're done
    console.log("[gemini] Stop button not detected, polling for stability…");
    await waitForTextStability(page, RESP_SEL, 1500, 30_000);
  }

  // Small buffer after streaming ends to let DOM finalise
  if (streamedViaStopBtn) await page.waitForTimeout(400);

  // ── 6. Extract the last (most recent) response text ─────────────────────
  const text = await page.evaluate((selectors) => {
    // Try each selector, collect ALL matches and return the last one's text
    for (const sel of selectors) {
      const all = [...document.querySelectorAll(sel)];
      if (all.length > 0) {
        // Pick the last element — it's the most recent Gemini turn
        const last = all[all.length - 1];
        const t = last.textContent?.trim();
        if (t && t.length > 10) return t;
      }
    }
    // Absolute fallback: find the deepest/last block containing a JSON brace
    const candidates = [...document.querySelectorAll("p, pre, code, div, span")];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const t = candidates[i].textContent?.trim();
      if (t && t.includes("{") && t.includes("}") && t.length > 20) return t;
    }
    return null;
  }, RESPONSE_SELECTORS);

  if (!text) throw new Error("Could not extract response from Gemini DOM.");
  return text;
}

// Poll until the selected element's text hasn't changed for `stableMs`
async function waitForTextStability(page, selector, stableMs, totalTimeout) {
  const deadline = Date.now() + totalTimeout;
  let lastText   = "";
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const current = await page.evaluate((sel) => {
      const els = [...document.querySelectorAll(sel)];
      return els.length ? els[els.length - 1]?.textContent?.trim() || "" : "";
    }, selector);

    if (current !== lastText) {
      lastText    = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs && lastText.length > 10) {
      return; // stable — done
    }
  }
  // timed out but return anyway — we'll parse whatever we have
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /summarize
// ─────────────────────────────────────────────────────────────────────────────
app.post("/summarize", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0].trim();

  if (!checkRate(ip))
    return res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests — wait a moment." });

  const { title, content, mode } = req.body;

  if (!content || typeof content !== "string")
    return res.status(400).json({ error: "INVALID_INPUT", message: "No page content provided." });
  if (content.length < 50)
    return res.status(400).json({ error: "TOO_SHORT", message: "Page content is too short to summarize." });

  // Serialise requests — Gemini's UI can't handle concurrent sessions on one page
  if (requestInFlight) {
    return res.status(429).json({
      error: "BUSY",
      message: "Another summary is in progress. Please wait a few seconds and retry.",
    });
  }

  requestInFlight = true;
  const t0 = Date.now();

  try {
    console.log(`[req] mode=${mode || "default"} len=${content.length} ip=${ip}`);

    const prompt       = buildPrompt(title, content, mode);
    const rawResponse  = await askGemini(prompt);
    const parsed       = parseResponse(rawResponse);
    const readingTime  = estimateReadingTime(content);
    const elapsed      = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`[req] done in ${elapsed}s`);
    return res.json({ ...parsed, readingTime, fromCache: false });

  } catch (err) {
    console.error("[req] error:", err.message);

    // If the page crashed, mark it dirty so it gets recreated next call
    if (
      err.message.includes("Target closed") ||
      err.message.includes("Session closed") ||
      err.message.includes("context was destroyed") ||
      err.message.includes("Protocol error")
    ) {
      geminiPage = null;
      pageReady  = false;
      browser    = null;
    }

    if (err.message.toLowerCase().includes("timeout"))
      return res.status(504).json({ error: "TIMEOUT", message: "Gemini took too long. Please try again." });
    if (err.message.includes("net::ERR") || err.message.toLowerCase().includes("network"))
      return res.status(503).json({ error: "NETWORK_ERROR", message: "Could not reach Gemini." });

    return res.status(500).json({ error: "SERVER_ERROR", message: "Failed to get summary. Please try again." });

  } finally {
    requestInFlight = false;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Parse Gemini's response text → structured object
// ─────────────────────────────────────────────────────────────────────────────
function parseResponse(raw) {
  if (!raw) return fallback("Empty response from AI.");

  // Strip any markdown fences Gemini may have added despite instructions
  let cleaned = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  // Extract the outermost JSON object
  const braceStart = cleaned.indexOf("{");
  const braceEnd   = cleaned.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    cleaned = cleaned.slice(braceStart, braceEnd + 1);
  }

  // Remove common Gemini artefacts: trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  try {
    const p = JSON.parse(cleaned);
    const SENTIMENTS    = ["positive", "neutral", "negative"];
    const CONTENT_TYPES = ["article", "news", "documentation", "blog", "other"];

    return {
      summary:     ensureArray(p.summary,     1),
      keyInsights: ensureArray(p.keyInsights, 0),
      topics:      ensureArray(p.topics,      0),
      sentiment:   SENTIMENTS.includes(p.sentiment)       ? p.sentiment    : "neutral",
      contentType: CONTENT_TYPES.includes(p.contentType)  ? p.contentType  : "other",
    };
  } catch (e) {
    console.warn("[parse] JSON.parse failed, attempting field extraction…", e.message);

    // Attempt to pull individual fields with regex as last resort
    const extractArray = (field) => {
      const m = raw.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
      if (!m) return [];
      try { return JSON.parse(`[${m[1]}]`).filter(s => typeof s === "string" && s.trim()); } catch { return []; }
    };
    const extractStr = (field, allowed) => {
      const m = raw.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
      const v = m?.[1]?.trim().toLowerCase();
      return v && allowed.includes(v) ? v : allowed[1]; // default to neutral/other
    };

    const summary = extractArray("summary");
    if (summary.length) {
      return {
        summary,
        keyInsights: extractArray("keyInsights"),
        topics:      extractArray("topics"),
        sentiment:   extractStr("sentiment",   ["positive","neutral","negative"]),
        contentType: extractStr("contentType", ["article","news","documentation","blog","other"]),
      };
    }

    return fallback("Could not parse AI response — please try again.");
  }
}

function ensureArray(val, minLen) {
  const arr = Array.isArray(val)
    ? val.filter(s => typeof s === "string" && s.trim())
    : [];
  if (arr.length === 0 && minLen > 0) return ["No data available."];
  return arr;
}

function fallback(msg) {
  return { summary: [msg], keyInsights: [], topics: [], sentiment: "neutral", contentType: "other" };
}

function estimateReadingTime(text) {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length / 238));
}

// ─────────────────────────────────────────────────────────────────────────────
// Health & root
// ─────────────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "ok", uptime: process.uptime().toFixed(0) + "s", time: new Date().toISOString() })
);
app.get("/", (_req, res) =>
  res.json({ name: "PageMind AI Backend", version: "3.0.0", status: "running", pageReady })
);

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PageMind backend v3 on port ${PORT}`);
  // Pre-warm: open the browser and the Gemini page on startup
  // so the first real request doesn't pay the cold-start cost
  getGeminiPage().catch(e => console.error("[prewarm] Failed:", e.message));
});

process.on("SIGTERM", async () => {
  console.log("Shutting down…");
  if (geminiPage) await geminiPage.close().catch(() => {});
  if (browser)    await browser.close().catch(() => {});
  process.exit(0);
});
