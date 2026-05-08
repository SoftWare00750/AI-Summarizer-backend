// server.js — PageMind AI Backend
// Automates gemini.com to summarize pages without needing an API key.
// Deploy on Render (Free tier works).

import express from "express";
import cors from "cors";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: "*", // Chrome extensions need this
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));
app.use(express.json({ limit: "50kb" }));

// ── Browser pool ──────────────────────────────────────────────────────────────
let browser = null;
let browserLaunchTime = null;
const BROWSER_MAX_AGE_MS = 30 * 60 * 1000; // Recycle browser every 30 min

async function getBrowser() {
  const now = Date.now();
  if (browser && browserLaunchTime && (now - browserLaunchTime) < BROWSER_MAX_AGE_MS) {
    try {
      // Check if browser is still alive
      await browser.version();
      return browser;
    } catch {
      browser = null;
    }
  }

  // Launch fresh browser
  if (browser) {
    try { await browser.close(); } catch {}
  }

  console.log("Launching browser...");
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process", // Required for Render free tier
      "--disable-extensions",
    ],
  });
  browserLaunchTime = Date.now();
  console.log("Browser ready.");
  return browser;
}

// ── Rate limiting (simple in-memory) ─────────────────────────────────────────
const requestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // requests per window per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const log = requestLog.get(ip) || [];
  const recent = log.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  requestLog.set(ip, recent);
  return true;
}

// ── Main summarize endpoint ───────────────────────────────────────────────────
app.post("/summarize", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests. Please wait a moment." });
  }

  const { title, content, mode } = req.body;

  if (!content || typeof content !== "string") {
    return res.status(400).json({ error: "INVALID_INPUT", message: "No page content provided." });
  }

  if (content.length < 50) {
    return res.status(400).json({ error: "TOO_SHORT", message: "Page content is too short to summarize." });
  }

  // Truncate to keep prompt reasonable
  const truncated = content.slice(0, 5000);

  const modeInstructions = {
    brief:    "3 bullet points, 1 key insight, up to 3 topics",
    default:  "4-6 bullet points, 3 key insights, up to 5 topics",
    detailed: "7-10 bullet points, 5 key insights, up to 8 topics",
  };
  const instruction = modeInstructions[mode] || modeInstructions.default;

  const prompt = `Analyze this webpage and respond ONLY with valid JSON (no markdown, no backticks, no explanation):

Page Title: ${title || "Untitled"}

Page Content:
${truncated}

Respond with EXACTLY this JSON structure:
{
  "summary": ["point 1", "point 2"],
  "keyInsights": ["insight 1"],
  "topics": ["topic1", "topic2"],
  "sentiment": "positive",
  "contentType": "article"
}

Rules:
- summary: ${instruction.split(",")[0]}
- keyInsights: ${instruction.split(",")[1] || "3 key insights"}
- topics: ${instruction.split(",")[2] || "up to 5 topics"} (short keyword strings)
- sentiment: EXACTLY one of: positive, neutral, negative
- contentType: EXACTLY one of: article, news, documentation, blog, other
- Return ONLY the JSON object, nothing else.`;

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    // Block unnecessary resources for speed
    await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot}", r => r.abort());
    await page.route("**/analytics**", r => r.abort());
    await page.route("**/gtag**", r => r.abort());

    console.log(`[${new Date().toISOString()}] Navigating to gemini.com...`);
    await page.goto("https://gemini.google.com/app", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Wait for the input field to be ready
    // Gemini's main input is a contenteditable div or textarea
    const inputSelector = 'rich-textarea div[contenteditable="true"], textarea[aria-label*="message"], div[data-testid="input-box"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });

    console.log("Input found, typing prompt...");

    // Type the prompt into Gemini's input
    const inputEl = await page.$(inputSelector);
    await inputEl.click();
    await inputEl.fill(prompt);

    // Small delay to ensure text is registered
    await page.waitForTimeout(500);

    // Submit — press Enter or click the send button
    const sendBtnSelector = 'button[aria-label*="Send"], button[data-testid="send-button"], button[aria-label*="send"]';
    const sendBtn = await page.$(sendBtnSelector);
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await inputEl.press("Enter");
    }

    console.log("Prompt submitted, waiting for response...");

    // Wait for Gemini to respond — look for the response container
    // Gemini streams responses, so we wait for streaming to complete
    const responseSelector = 'message-content .markdown, model-response .response-content, [data-testid="response-container"] p, .response-content';
    
    // First wait for any response to appear
    await page.waitForSelector(responseSelector, { timeout: 45000 });
    
    // Wait for streaming to finish — Gemini shows a "stop" button while generating
    // We wait until the stop button disappears
    try {
      await page.waitForSelector('button[aria-label*="Stop"], button[data-testid="stop-button"]', { timeout: 5000 });
      await page.waitForSelector('button[aria-label*="Stop"], button[data-testid="stop-button"]', { state: "hidden", timeout: 30000 });
    } catch {
      // Stop button might not appear for short responses, that's fine
      await page.waitForTimeout(3000);
    }

    // Extract the response text
    const responseText = await page.evaluate(() => {
      // Try multiple selectors to find Gemini's response
      const selectors = [
        "model-response .markdown",
        ".response-content .markdown",
        "message-content",
        "[data-testid='response-container']",
        ".ProseMirror", // sometimes used for output
      ];
      
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 20) {
          return el.textContent.trim();
        }
      }
      
      // Fallback: get all response-looking text
      const allResponses = document.querySelectorAll(".response-container, .model-response, message-content");
      if (allResponses.length > 0) {
        const last = allResponses[allResponses.length - 1];
        return last.textContent.trim();
      }
      
      return null;
    });

    if (!responseText) {
      throw new Error("Could not extract response from Gemini");
    }

    console.log("Got response, parsing...");
    const parsed = parseGeminiResponse(responseText);
    const readingTime = estimateReadingTime(content);

    return res.json({ ...parsed, readingTime, fromCache: false });

  } catch (err) {
    console.error("Summarize error:", err.message);

    // If page got into bad state, close it and reset browser
    if (err.message.includes("Target closed") || err.message.includes("Session closed")) {
      browser = null;
    }

    if (err.message.includes("timeout") || err.message.includes("Timeout")) {
      return res.status(504).json({ error: "TIMEOUT", message: "Gemini took too long to respond. Please try again." });
    }
    if (err.message.includes("net::ERR") || err.message.includes("NETWORK")) {
      return res.status(503).json({ error: "NETWORK_ERROR", message: "Could not reach Gemini. Check server connectivity." });
    }

    return res.status(500).json({ error: "SERVER_ERROR", message: "Failed to get summary. Please try again." });

  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.json({
    name: "PageMind AI Backend",
    version: "1.0.0",
    status: "running",
    endpoints: {
      "POST /summarize": "Summarize page content via Gemini",
      "GET /health": "Health check",
    },
  });
});

// ── Parse Gemini's response ───────────────────────────────────────────────────
function parseGeminiResponse(raw) {
  if (!raw) return buildFallback("Empty response from AI.");

  try {
    let cleaned = raw.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    const parsed = JSON.parse(cleaned);
    const validSentiments = ["positive", "neutral", "negative"];
    const validContentTypes = ["article", "news", "documentation", "blog", "other"];

    return {
      summary: Array.isArray(parsed.summary)
        ? parsed.summary.filter(s => typeof s === "string" && s.trim())
        : ["No summary available."],
      keyInsights: Array.isArray(parsed.keyInsights)
        ? parsed.keyInsights.filter(s => typeof s === "string" && s.trim())
        : [],
      topics: Array.isArray(parsed.topics)
        ? parsed.topics.filter(s => typeof s === "string" && s.trim())
        : [],
      sentiment: validSentiments.includes(parsed.sentiment) ? parsed.sentiment : "neutral",
      contentType: validContentTypes.includes(parsed.contentType) ? parsed.contentType : "other",
    };
  } catch {
    // Try to salvage partial JSON
    const summaryMatch = raw.match(/"summary"\s*:\s*\[([\s\S]*?)\]/);
    if (summaryMatch) {
      try {
        const partialSummary = JSON.parse(`[${summaryMatch[1]}]`);
        if (Array.isArray(partialSummary) && partialSummary.length > 0) {
          return { summary: partialSummary, keyInsights: [], topics: [], sentiment: "neutral", contentType: "other" };
        }
      } catch {}
    }
    return buildFallback("Could not parse AI response.");
  }
}

function buildFallback(msg) {
  return { summary: [msg], keyInsights: [], topics: [], sentiment: "neutral", contentType: "other" };
}

function estimateReadingTime(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 238));
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PageMind backend running on port ${PORT}`);
  console.log("Pre-warming browser...");
  getBrowser().catch(err => console.error("Browser pre-warm failed:", err.message));
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});