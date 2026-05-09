// server.js — PageMind AI Backend v5 (Groq added as fallback)
// Primary: Groq API (free, fast). Fallback: Gemini API.

import express from "express";
import cors from "cors";

const app = express();
const PORT            = process.env.PORT || 3000;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "100kb" }));

// ── Rate limiter ──────────────────────────────────────────────────────────────
const rateLog = new Map();
function checkRate(ip) {
  const now    = Date.now();
  const log    = rateLog.get(ip) || [];
  const recent = log.filter(t => now - t < 60_000);
  if (recent.length >= 8) return false;
  recent.push(now);
  rateLog.set(ip, recent);
  return true;
}

// ── Smart content truncation ──────────────────────────────────────────────────
function smartTruncate(text, max = 4000) {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 600).trimEnd();
  const tail = text.slice(-500).trimStart();
  return `${head}\n\n[…content trimmed…]\n\n${tail}`;
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(title, content, mode) {
  const modeMap = {
    brief:    { bullets: 3, insights: 1, topics: 3 },
    default:  { bullets: 5, insights: 3, topics: 5 },
    detailed: { bullets: 8, insights: 5, topics: 8 },
  };
  const { bullets, insights, topics } = modeMap[mode] || modeMap.default;
  const body = smartTruncate(content);

  return `You are a precise webpage summarizer. Read the content below and respond with a single JSON object — no markdown fences, no explanation, no extra text before or after.

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
7. All strings must be in English.`;
}

// ── Groq API (OpenAI-compatible, free tier) ───────────────────────────────────
async function askGroq(prompt) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured.");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq API error: ${err?.error?.message || `HTTP ${res.status}`}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty response from Groq API.");
  return text;
}

// ── Gemini API ────────────────────────────────────────────────────────────────
async function askGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured.");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini API error: ${err?.error?.message || `HTTP ${res.status}`}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response from Gemini API.");
  return text;
}

// ── Ask AI — try Groq first, fall back to Gemini ─────────────────────────────
async function askAI(prompt) {
  if (GROQ_API_KEY) {
    try {
      console.log("[ai] trying Groq...");
      const result = await askGroq(prompt);
      console.log("[ai] Groq success");
      return result;
    } catch (err) {
      console.warn("[ai] Groq failed, falling back to Gemini:", err.message);
    }
  }

  if (GEMINI_API_KEY) {
    console.log("[ai] trying Gemini...");
    const result = await askGemini(prompt);
    console.log("[ai] Gemini success");
    return result;
  }

  throw new Error("No AI provider configured. Set GROQ_API_KEY or GEMINI_API_KEY.");
}

// ── Parse response ────────────────────────────────────────────────────────────
function parseResponse(raw) {
  if (!raw) return fallback("Empty response from AI.");

  let cleaned = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  const braceStart = cleaned.indexOf("{");
  const braceEnd   = cleaned.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    cleaned = cleaned.slice(braceStart, braceEnd + 1);
  }

  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  try {
    const p = JSON.parse(cleaned);
    const SENTIMENTS    = ["positive", "neutral", "negative"];
    const CONTENT_TYPES = ["article", "news", "documentation", "blog", "other"];

    return {
      summary:     ensureArray(p.summary,     1),
      keyInsights: ensureArray(p.keyInsights, 0),
      topics:      ensureArray(p.topics,      0),
      sentiment:   SENTIMENTS.includes(p.sentiment)      ? p.sentiment    : "neutral",
      contentType: CONTENT_TYPES.includes(p.contentType) ? p.contentType  : "other",
    };
  } catch (e) {
    console.warn("[parse] JSON.parse failed:", e.message);

    const extractArray = (field) => {
      const m = raw.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
      if (!m) return [];
      try { return JSON.parse(`[${m[1]}]`).filter(s => typeof s === "string" && s.trim()); } catch { return []; }
    };
    const extractStr = (field, allowed) => {
      const m = raw.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
      const v = m?.[1]?.trim().toLowerCase();
      return v && allowed.includes(v) ? v : allowed[1];
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

// ── POST /summarize ───────────────────────────────────────────────────────────
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

  const t0 = Date.now();

  try {
    console.log(`[req] mode=${mode || "default"} len=${content.length} ip=${ip}`);

    const prompt      = buildPrompt(title, content, mode);
    const rawResponse = await askAI(prompt);
    const parsed      = parseResponse(rawResponse);
    const readingTime = estimateReadingTime(content);
    const elapsed     = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`[req] done in ${elapsed}s`);
    return res.json({ ...parsed, readingTime, fromCache: false });

  } catch (err) {
    console.error("[req] error:", err.message);

    if (err.name === "TimeoutError" || err.message.toLowerCase().includes("timeout"))
      return res.status(504).json({ error: "TIMEOUT", message: "AI took too long. Please try again." });
    if (err.message.includes("not configured"))
      return res.status(500).json({ error: "CONFIG_ERROR", message: "No AI provider configured on server." });
    if (err.message.includes("Groq API error") || err.message.includes("Gemini API error"))
      return res.status(502).json({ error: "API_ERROR", message: err.message });

    return res.status(500).json({ error: "SERVER_ERROR", message: "Failed to get summary. Please try again." });
  }
});

// ── Health & root ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({
    status: "ok",
    uptime: process.uptime().toFixed(0) + "s",
    time: new Date().toISOString(),
    groqConfigured:   !!GROQ_API_KEY,
    geminiConfigured: !!GEMINI_API_KEY,
  })
);

app.get("/", (_req, res) =>
  res.json({
    name: "PageMind AI Backend",
    version: "5.0.0",
    status: "running",
    engine: GROQ_API_KEY ? "Groq (primary)" : "Gemini (fallback)",
    groqConfigured:   !!GROQ_API_KEY,
    geminiConfigured: !!GEMINI_API_KEY,
  })
);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PageMind backend v5 on port ${PORT}`);
  if (!GROQ_API_KEY && !GEMINI_API_KEY) {
    console.warn("⚠️  WARNING: Neither GROQ_API_KEY nor GEMINI_API_KEY is set.");
  } else {
    if (GROQ_API_KEY)   console.log("✅ Groq API key configured (primary).");
    if (GEMINI_API_KEY) console.log("✅ Gemini API key configured (fallback).");
  }
});

process.on("SIGTERM", () => { console.log("Shutting down…"); process.exit(0); });
