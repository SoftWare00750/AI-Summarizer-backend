// server.js — PageMind AI Backend v2
// Automates gemini.google.com UI via Playwright to summarize pages.
// No Gemini API key required. Deploy on Render (Free tier).

import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: "*",   // Chrome extensions require wildcard
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));
app.use(express.json({ limit: "100kb" }));

// ── Browser singleton ─────────────────────────────────────────────────────────
let browser        = null;
let browserBornAt  = null;
const MAX_BROWSER_AGE_MS = 25 * 60 * 1000;

async function getBrowser() {
  const now = Date.now();

  if (browser && browserBornAt && (now - browserBornAt) < MAX_BROWSER_AGE_MS) {
    try {
      await browser.version();
      return browser;
    } catch {
      browser = null;
    }
  }

  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }

  console.log("[browser] Launching Chromium...");
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--mute-audio",
    ],
  });
  browserBornAt = Date.now();
  console.log("[browser] Ready.");
  return browser;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RL_WINDOW_MS = 60_000;
const RL_MAX       = 8;

function checkRateLimit(ip) {
  const now  = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  if (hits.length >= RL_MAX) return false;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW_MS;
  for (const [ip, hits] of rateLimitMap) {
    const fresh = hits.filter(t => t > cutoff);
    if (!fresh.length) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, fresh);
  }
}, 5 * 60_000);

// ── POST /summarize ───────────────────────────────────────────────────────────
app.post("/summarize", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0].trim();

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests — please wait a moment." });
  }

  const { title = "Untitled", content, mode = "default" } = req.body;

  if (!content || typeof content !== "string") {
    return res.status(400).json({ error: "INVALID_INPUT", message: "No page content provided." });
  }
  if (content.trim().length < 50) {
    return res.status(400).json({ error: "TOO_SHORT", message: "Page content is too short to summarize." });
  }

  const truncated = content.slice(0, 5000).trim();

  const modeCfg = {
    brief:    { bullets: "3",    insights: "1", topics: "up to 3" },
    default:  { bullets: "4-6",  insights: "3", topics: "up to 5" },
    detailed: { bullets: "7-10", insights: "5", topics: "up to 8" },
  }[mode] || { bullets: "4-6", insights: "3", topics: "up to 5" };

  const prompt = `Analyze this webpage content and respond ONLY with a valid JSON object. No markdown, no backticks, no explanation.

Page Title: ${title}

Page Content:
${truncated}

Respond with EXACTLY this JSON structure:
{
  "summary": ["bullet point 1", "bullet point 2"],
  "keyInsights": ["insight 1"],
  "topics": ["topic1", "topic2"],
  "sentiment": "positive",
  "contentType": "article"
}

Rules:
- summary: ${modeCfg.bullets} concise bullet points
- keyInsights: ${modeCfg.insights} deeper insights beyond the bullets
- topics: ${modeCfg.topics} short keyword strings (1-3 words each)
- sentiment: EXACTLY one of: positive, neutral, negative
- contentType: EXACTLY one of: article, news, documentation, blog, other
- Return ONLY the raw JSON. No other text.`;

  let page = null;
  try {
    const b = await getBrowser();
    page    = await b.newPage();

    await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot,mp4,mp3}", r => r.abort());
    await page.route("**/{analytics,gtag,doubleclick,ads}**", r => r.abort());

    // ── Navigate ───────────────────────────────────────────────────────────
    console.log(`[${ip}] Navigating to Gemini...`);
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // ── Find input ─────────────────────────────────────────────────────────
    const INPUT_SELECTORS = [
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][data-testid]',
      'div.ql-editor[contenteditable="true"]',
      'textarea[aria-label]',
      'div[contenteditable="true"]',
    ];

    let inputEl = null;
    for (const sel of INPUT_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 12_000 });
        inputEl = await page.$(sel);
        if (inputEl) { console.log(`[${ip}] Input: ${sel}`); break; }
      } catch { /* try next */ }
    }

    if (!inputEl) throw new Error("GEMINI_INPUT_NOT_FOUND");

    // ── Type prompt ────────────────────────────────────────────────────────
    await inputEl.click();
    await page.waitForTimeout(300);
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(400);

    // ── Submit ─────────────────────────────────────────────────────────────
    const SEND_SELECTORS = [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[data-testid*="send"]',
    ];
    let sent = false;
    for (const sel of SEND_SELECTORS) {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); sent = true; break; }
    }
    if (!sent) await page.keyboard.press("Enter");
    console.log(`[${ip}] Prompt submitted.`);

    // ── Wait for response ──────────────────────────────────────────────────
    const RESPONSE_SELECTORS = [
      "model-response .markdown",
      "model-response .response-content",
      ".response-content .markdown",
      "message-content .markdown",
      ".model-response-text",
      "[data-testid='response-container']",
    ];

    let appeared = false;
    for (const sel of RESPONSE_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 40_000 });
        appeared = true;
        console.log(`[${ip}] Response selector matched: ${sel}`);
        break;
      } catch { /* try next */ }
    }
    if (!appeared) throw new Error("GEMINI_RESPONSE_TIMEOUT");

    // Wait for streaming to finish
    const STOP_BTN = 'button[aria-label*="Stop"], button[aria-label*="stop"]';
    try {
      await page.waitForSelector(STOP_BTN, { timeout: 4_000 });
      await page.waitForSelector(STOP_BTN, { state: "hidden", timeout: 45_000 });
    } catch {
      await page.waitForTimeout(2_500);
    }

    // ── Extract text ───────────────────────────────────────────────────────
    const rawText = await page.evaluate(() => {
      const selectors = [
        "model-response .markdown",
        ".response-content .markdown",
        "message-content .markdown",
        ".model-response-text",
        "model-response",
        "message-content",
      ];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (!els.length) continue;
        const last = els[els.length - 1];
        const text = (last.innerText || last.textContent || "").trim();
        if (text.length > 10) return text;
      }
      return null;
    });

    if (!rawText) throw new Error("GEMINI_EMPTY_RESPONSE");

    console.log(`[${ip}] Parsing response (${rawText.length} chars)...`);
    const parsed      = parseResponse(rawText);
    const readingTime = estimateReadingTime(content);

    return res.json({ ...parsed, readingTime, fromCache: false });

  } catch (err) {
    console.error(`[${ip}] Error: ${err.message}`);

    if (/Target closed|Session closed|context was destroyed/i.test(err.message)) {
      browser = null;
    }

    if (err.message === "GEMINI_INPUT_NOT_FOUND")
      return res.status(503).json({ error: "SERVICE_ERROR", message: "Could not find Gemini input. UI may have changed — check server logs." });
    if (err.message === "GEMINI_RESPONSE_TIMEOUT")
      return res.status(504).json({ error: "TIMEOUT", message: "Gemini did not respond in time. Please try again." });
    if (err.message === "GEMINI_EMPTY_RESPONSE")
      return res.status(503).json({ error: "EMPTY_RESPONSE", message: "Gemini returned an empty response. Please try again." });
    if (/timeout/i.test(err.message))
      return res.status(504).json({ error: "TIMEOUT", message: "Request timed out. Please try again." });
    if (/net::|ERR_|NETWORK/i.test(err.message))
      return res.status(503).json({ error: "NETWORK_ERROR", message: "Network error reaching Gemini." });

    return res.status(500).json({ error: "SERVER_ERROR", message: "Unexpected server error. Please try again." });

  } finally {
    if (page) try { await page.close(); } catch {}
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString(), browser: !!browser });
});

app.get("/", (_req, res) => {
  res.json({
    name: "PageMind AI Backend",
    version: "2.0.0",
    status: "running",
    note: "Summarizes pages via Gemini UI automation. No API key required.",
    endpoints: {
      "POST /summarize": "{ title, content, mode } => { summary, keyInsights, topics, sentiment, contentType, readingTime }",
      "GET /health": "Health check",
    },
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseResponse(raw) {
  if (!raw) return fallback("Empty response.");
  try {
    let cleaned = raw.trim()
      .replace(/^```json\s*/im, "")
      .replace(/^```\s*/im, "")
      .replace(/\s*```\s*$/im, "")
      .trim();

    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found");
    const p = JSON.parse(match[0]);

    const validSentiments   = ["positive", "neutral", "negative"];
    const validContentTypes = ["article", "news", "documentation", "blog", "other"];

    return {
      summary:     toStringArray(p.summary, "No summary available."),
      keyInsights: toStringArray(p.keyInsights),
      topics:      toStringArray(p.topics),
      sentiment:   validSentiments.includes(p.sentiment)    ? p.sentiment    : "neutral",
      contentType: validContentTypes.includes(p.contentType) ? p.contentType : "other",
    };
  } catch {
    // Salvage: try to pull summary array out manually
    const m = raw.match(/"summary"\s*:\s*\[([\s\S]*?)\]/);
    if (m) {
      try {
        const arr = JSON.parse(`[${m[1]}]`);
        if (Array.isArray(arr) && arr.length) {
          return { summary: arr, keyInsights: [], topics: [], sentiment: "neutral", contentType: "other" };
        }
      } catch {}
    }
    return fallback("Could not parse AI response.");
  }
}

function toStringArray(val, fallbackItem) {
  if (!Array.isArray(val)) return fallbackItem ? [fallbackItem] : [];
  const filtered = val.filter(s => typeof s === "string" && s.trim());
  return filtered.length ? filtered : (fallbackItem ? [fallbackItem] : []);
}

function fallback(msg) {
  return { summary: [msg], keyInsights: [], topics: [], sentiment: "neutral", contentType: "other" };
}

function estimateReadingTime(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 238));
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PageMind backend v2 running on port ${PORT}`);
  getBrowser().catch(err => console.error("[browser] Pre-warm failed:", err.message));
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
