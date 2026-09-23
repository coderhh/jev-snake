import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TYPESAFE_API_KEY;
const API_URL = "https://api.typesafe.ai/v1/systemone";
// Local Laya inference server (see D:\Projects\laya\server.py).
const LAYA_URL = process.env.LAYA_URL || "http://127.0.0.1:8000/predict";
// Pricing (USD per million tokens). Jev bills input only (output is free). Laya is self-hosted -> free.
const JEV_IN = parseFloat(process.env.JEV_PRICE_IN_PER_MTOK || "0.042");
const JEV_OUT = parseFloat(process.env.JEV_PRICE_OUT_PER_MTOK || "0");
const CLAUDE_IN = parseFloat(process.env.CLAUDE_PRICE_IN_PER_MTOK || "0.80");
const CLAUDE_OUT = parseFloat(process.env.CLAUDE_PRICE_OUT_PER_MTOK || "4.0");
const LAYA_IN = 0;
const LAYA_OUT = 0;
function costUsd(usage, priceIn, priceOut) {
  const i = usage?.input_tokens ?? 0;
  const o = usage?.output_tokens ?? 0;
  return (i * priceIn + o * priceOut) / 1e6;
}
// Azure AI Foundry hosting Claude (Anthropic messages API at an Azure endpoint).
const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT; // base URL incl. model path
const AZURE_API_KEY = process.env.AZURE_API_KEY;
const AZURE_MODEL = process.env.AZURE_MODEL || "claude-3-5-haiku-20241022";
function azureMessagesUrl() {
  if (!AZURE_ENDPOINT) return null;
  let u = AZURE_ENDPOINT.replace(/\/$/, "");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u; // Azure endpoint may omit the scheme
  return u.endsWith("/v1/messages") ? u : u + "/v1/messages";
}

app.use(express.json());
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "public")));

/**
 * Send typed questions to Jev and measure round-trip latency.
 * Code owns the workflow (timing, applying the answer); Jev supplies the judgment.
 */
async function askJev(questions, state) {
  const body = { state, model: "jev-latest", questions };

  const started = performance.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const elapsedMs = performance.now() - started;

  if (!res.ok) {
    const err = new Error(`TypeSafe API ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return { elapsedMs, data };
}

function noKey(res) {
  return res.status(500).json({
    error:
      "TYPESAFE_API_KEY is not set. Get a key from the TypeSafe dashboard and export it as TYPESAFE_API_KEY.",
  });
}

const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const NAME = (d) => (d.x === 1 ? "right" : d.x === -1 ? "left" : d.y === 1 ? "down" : "up");

// Code owns the rules: compute which moves are legal (non-reversing and not
// immediately fatal). Jev only chooses among safe options. The model cannot
// pick a value we omit, so we never offer the always-fatal reverse.
function legalMoves(snake, dir, size) {
  const head = snake[0];
  // The tail moves out of the way unless we just ate; conservatively treat the
  // tail cell as free (it usually will be).
  const body = snake.slice(0, -1);
  const safe = [];
  for (const [name, d] of Object.entries(DIRS)) {
    if (d.x === -dir.x && d.y === -dir.y) continue; // never reverse into the neck
    const nx = head.x + d.x;
    const ny = head.y + d.y;
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue; // wall
    if (body.some((s) => s.x === nx && s.y === ny)) continue; // self
    safe.push({ name, d });
  }
  return safe;
}

function buildGrid(snake, food, size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    let row = "";
    for (let x = 0; x < size; x++) {
      if (food.x === x && food.y === y) row += "F";
      else if (snake[0].x === x && snake[0].y === y) row += "H";
      else if (snake.some((s) => s.x === x && s.y === y)) row += "#";
      else row += ".";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

// --- Snake: Jev picks the next direction from the board state ---
app.post("/api/move", async (req, res) => {
  if (!API_KEY) return noKey(res);

  const { snake, food, direction, size } = req.body || {};
  if (!Array.isArray(snake) || !food || !direction || !size) {
    return res.status(422).json({ error: "snake, food, direction and size are required" });
  }
  const dir = DIRS[direction];
  if (!dir) return res.status(422).json({ error: "unknown direction" });

  const safe = legalMoves(snake, dir, size);

  // No safe move: the game is doomed. Report it; code on the client ends the run.
  if (safe.length === 0) {
    return res.json({ ok: true, doomed: true, direction: NAME(dir), safeMoves: [], usage: null });
  }

  // Exactly one safe move: code decides; no need to spend tokens. (Code owns
  // deterministic cases; Jev supplies judgment only where a real choice exists.)
  if (safe.length === 1) {
    return res.json({
      ok: true,
      forced: true,
      direction: safe[0].name,
      safeMoves: safe.map((m) => m.name),
      usage: { input_tokens: 0, output_tokens: 0 },
      latencyMs: 0,
    });
  }

  // Two or more safe moves: ask Jev to pick the best one toward the food.
  const grid = buildGrid(snake, food, size);
  const criteria = {};
  for (const m of safe) {
    criteria[m.name] =
      m.name === "up" ? "Move the head up one row (row index decreases)"
      : m.name === "down" ? "Move the head down one row (row index increases)"
      : m.name === "left" ? "Move the head left one column (column index decreases)"
      : "Move the head right one column (column index increases)";
  }

  const state = {
    size,
    direction,
    grid,
    legend: { ".": "empty", "#": "snake body", H: "snake head", F: "food" },
  };
  const questions = {
    move: {
      type: "choice",
      instructions:
        "You are playing Snake on a `size`x`size` grid. `grid` shows the board row by row: '.' is empty, '#' is the snake body, 'H' is the head, 'F' is the food. `direction` is the current heading. The options below are the only legal moves (the reverse and any wall/body collision have already been removed). Pick the one that best steers the head toward the food.",
      criteria,
    },
  };

  try {
    const { elapsedMs, data } = await askJev(questions, state);
    res.json({
      ok: true,
      latencyMs: Math.round(elapsedMs * 10) / 10,
      model: data.model,
      direction: data.answers?.move?.choice ?? safe[0].name,
      confidence: data.answers?.move?.confidence ?? null,
      probabilities: data.answers?.move?.probabilities ?? null,
      safeMoves: safe.map((m) => m.name),
      usage: data.usage,
      cost: costUsd(data.usage, JEV_IN, JEV_OUT),
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, body: err.body });
  }
});

// --- Snake: Claude picks the next direction (same legal-moves logic) ---
app.post("/api/move-claude", async (req, res) => {
  const url = azureMessagesUrl();
  if (!url || !AZURE_API_KEY) {
    return res.status(500).json({
      error:
        "AZURE_ENDPOINT and AZURE_API_KEY are not set. Add them to .env to enable the Claude comparison.",
    });
  }
  const { snake, food, direction, size } = req.body || {};
  if (!Array.isArray(snake) || !food || !direction || !size) {
    return res.status(422).json({ error: "snake, food, direction and size are required" });
  }
  const dir = DIRS[direction];
  if (!dir) return res.status(422).json({ error: "unknown direction" });

  const safe = legalMoves(snake, dir, size);
  if (safe.length === 0) {
    return res.json({ ok: true, doomed: true, direction: NAME(dir), safeMoves: [], usage: null });
  }
  if (safe.length === 1) {
    return res.json({
      ok: true,
      forced: true,
      direction: safe[0].name,
      safeMoves: safe.map((m) => m.name),
      usage: { input_tokens: 0, output_tokens: 0 },
      latencyMs: 0,
    });
  }

  const grid = buildGrid(snake, food, size);
  const legal = safe.map((m) => m.name).join(", ");
  const prompt =
    `You are playing Snake on a ${size}x${size} grid. The board is shown row by row below; ` +
    `row 0 is the top. '.' is empty, '#' is the snake body, 'H' is the head, 'F' is the food.\n\n` +
    `Current heading: ${direction}\n` +
    `Legal next moves (the only ones allowed): ${legal}\n\n` +
    `${grid}\n\n` +
    `Pick the legal move that best steers the head toward the food while avoiding walls and the body. ` +
    `Reply with exactly one word from the legal moves list and nothing else.`;

  const started = performance.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + AZURE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AZURE_MODEL,
        max_tokens: 300,
        system:
          "You are a Snake-playing bot. Output ONLY the next move as a single lowercase word: one of up, down, left, right. Never output reasoning, punctuation, or any other text.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const elapsedMs = performance.now() - started;
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: `Azure ${r.status}: ${JSON.stringify(data)}`, body: data });
    }
    const text = (data.content?.[0]?.text || "").trim().toLowerCase();
    // Take the LAST legal direction word the model mentions (reasoning models
    // often state the answer at the end); fall back to the first legal move.
    let last = null;
    for (const m of safe) {
      let idx = text.lastIndexOf(m.name);
      if (idx !== -1 && (last == null || idx > last.idx)) last = { name: m.name, idx };
    }
    const directionOut = last ? last.name : safe[0].name;
    res.json({
      ok: true,
      latencyMs: Math.round(elapsedMs * 10) / 10,
      model: data.model,
      direction: directionOut,
      raw: text,
      safeMoves: safe.map((m) => m.name),
      usage: data.usage, // {input_tokens, output_tokens}
      cost: costUsd(data.usage, CLAUDE_IN, CLAUDE_OUT),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Report the configured Claude model name (for the UI pill).
app.get("/api/claude-model", (req, res) => {
  res.json({ model: AZURE_MODEL, configured: Boolean(AZURE_API_KEY && AZURE_ENDPOINT) });
});

// --- Snake: local Laya picks the next direction (proxied to the Python Laya server) ---
app.post("/api/move-laya", async (req, res) => {
  const { snake, food, direction, size } = req.body || {};
  if (!Array.isArray(snake) || !food || !direction || !size) {
    return res.status(422).json({ error: "snake, food, direction and size are required" });
  }
  try {
    const r = await fetch(LAYA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snake, food, direction, size }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      return res.status(r.status || 500).json({ ok: false, error: (data && data.error) || `Laya ${r.status}` });
    }
    // Laya is self-hosted: usage null, cost 0. Forward everything else as-is.
    res.json({
      ok: true,
      doomed: data.doomed || false,
      forced: data.forced || false,
      direction: data.direction,
      confidence: data.confidence ?? null,
      assist: data.assist || false,
      safeMoves: data.safeMoves,
      latencyMs: data.latencyMs ?? 0,
      usage: data.usage, // null
      cost: 0,
      routing: data.routing,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: `Laya server unreachable at ${LAYA_URL}. Is D:\\Projects\\laya\\server.py running? (${err.message})`,
    });
  }
});

app.get("/api/pricing", (req, res) => {
  res.json({
    jev: { inPerMtok: JEV_IN, outPerMtok: JEV_OUT, outputFree: JEV_OUT === 0 },
    claude: { inPerMtok: CLAUDE_IN, outPerMtok: CLAUDE_OUT, outputFree: CLAUDE_OUT === 0 },
    laya: { inPerMtok: LAYA_IN, outPerMtok: LAYA_OUT, outputFree: true, selfHosted: true },
  });
});

// --- Single timed trial (kept for the speed demo) ---
app.get("/api/ask", async (req, res) => {
  if (!API_KEY) return noKey(res);

  const sample = [
    "Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP.",
    "Thanks so much, the new dashboard is great and my team loves it!",
    "Could you send me a copy of last month's invoice when you get a chance?",
    "This is unacceptable. I've emailed four times and nobody has responded. Fix it now.",
    "Just checking in on the feature request I submitted last week.",
  ];
  const state = sample[Math.floor(Math.random() * sample.length)];

  const questions = {
    sentiment: {
      type: "choice",
      instructions: "What tone does this message convey?",
      criteria: {
        positive: "Friendly, grateful, or upbeat",
        neutral: "Factual, no strong emotion",
        negative: "Frustrated, annoyed, or upset",
      },
    },
    is_urgent: {
      type: "noul",
      instructions: "Does this message convey urgency or time-sensitivity?",
    },
  };

  try {
    const { elapsedMs, data } = await askJev(questions, state);
    res.json({
      ok: true,
      latencyMs: Math.round(elapsedMs * 10) / 10,
      model: data.model,
      state,
      answers: data.answers,
      usage: data.usage,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, body: err.body });
  }
});

app.listen(PORT, () => {
  console.log(`jev-snake running at http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn("Warning: TYPESAFE_API_KEY not set. Set it before playing with Jev.");
  }
});
