/* Umabonakude background service worker — talks to a Gradio agent (HF Space or Colab share). */

// Default Space; user can override at runtime via popup ("Agent endpoint").
const DEFAULT_BASE = "https://sphahh222-umabonakude.hf.space";
// Function names to try, in order. Your notebook exposes `generate_text`;
// older HF Space ChatInterface exposes `respond`; default is `predict`.
const FN_CANDIDATES = ["generate_text", "predict", "respond"];

async function getBase() {
  const { agent_endpoint } = await chrome.storage.local.get("agent_endpoint");
  let url = (agent_endpoint || DEFAULT_BASE).trim();
  if (!url) url = DEFAULT_BASE;
  return url.replace(/\/+$/, "");
}

/* ---------- prompt builders ---------- */
function buildFillPrompt({ url, title, profile, fields }) {
  const fieldList = fields
    .map((f, i) => {
      const opts =
        f.options && f.options.length
          ? ` | options: ${f.options.map((o) => o.text || o.value).slice(0, 8).join(", ")}`
          : "";
      return `${i + 1}. id="${f.id}" label="${f.label}" type=${f.type}${opts}`;
    })
    .join("\n");
  return [
    "You are an AI form-filling assistant. Generate realistic, sensible values",
    "for each form field below using the user profile when relevant.",
    "",
    "USER PROFILE:",
    profile?.trim() ? profile.trim() : "(no profile — use plausible generic values)",
    "",
    `PAGE: ${title || ""} — ${url || ""}`,
    "",
    "FIELDS:",
    fieldList,
    "",
    "Respond ONLY with a compact JSON array, one object per field:",
    '[{"id":"<id>","value":"<string-or-boolean>"}, ...]',
    "For checkboxes return true/false. For selects/radios return one of the option texts.",
    "No commentary, only the JSON array.",
  ].join("\n");
}

/* ---------- Gradio adapters ---------- */

/** Try the new queue API: POST /gradio_api/call/<fn> -> SSE stream. */
async function callGradioQueue(base, fn, dataArr) {
  const r = await fetch(`${base}/gradio_api/call/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: dataArr }),
  });
  if (!r.ok) throw new Error(`POST ${fn} HTTP ${r.status}`);
  const j = await r.json();
  const eventId = j?.event_id;
  if (!eventId) throw new Error(`No event_id from ${fn}`);
  const sr = await fetch(`${base}/gradio_api/call/${fn}/${eventId}`);
  if (!sr.ok || !sr.body) throw new Error(`Stream HTTP ${sr.status}`);
  const reader = sr.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastEvent = "";
  let lastData = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("event:")) lastEvent = t.slice(6).trim();
      else if (t.startsWith("data:")) lastData = t.slice(5).trim();
      if (lastEvent === "complete" && lastData) {
        try {
          const parsed = JSON.parse(lastData);
          const out = Array.isArray(parsed) ? parsed[0] : parsed;
          return typeof out === "string" ? out : JSON.stringify(out);
        } catch {
          return lastData;
        }
      }
      if (lastEvent === "error") {
        throw new Error(`Agent error from ${fn}: ${lastData || "unknown"}`);
      }
    }
  }
  throw new Error(`Stream ended without complete (${fn})`);
}

/** Try the legacy API: POST /run/<fn> -> { data: [...] } */
async function callGradioLegacy(base, fn, dataArr) {
  const r = await fetch(`${base}/run/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: dataArr }),
  });
  if (!r.ok) throw new Error(`POST /run/${fn} HTTP ${r.status}`);
  const j = await r.json();
  const out = j?.data?.[0];
  if (out == null) throw new Error(`Empty data from /run/${fn}`);
  return typeof out === "string" ? out : JSON.stringify(out);
}

/**
 * Try multiple endpoints / data shapes until one works.
 * `mode`: "single" → data: [text]
 *         "chat"   → data: [text, system, max_tokens, temperature, top_p]
 */
async function callAgent(text, { mode = "single", system = "You are a helpful assistant." } = {}) {
  const base = await getBase();
  const single = [text];
  const chat = [text, system, 512, 0.7, 0.95];
  const attempts = [];
  for (const fn of FN_CANDIDATES) {
    attempts.push({ fn, kind: "queue", data: mode === "chat" ? chat : single });
    attempts.push({ fn, kind: "queue", data: mode === "chat" ? single : chat });
    attempts.push({ fn, kind: "legacy", data: mode === "chat" ? chat : single });
    attempts.push({ fn, kind: "legacy", data: mode === "chat" ? single : chat });
  }
  let lastErr;
  for (const a of attempts) {
    try {
      const out =
        a.kind === "queue"
          ? await callGradioQueue(base, a.fn, a.data)
          : await callGradioLegacy(base, a.fn, a.data);
      if (out && String(out).trim()) return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr?.message || "All agent endpoints failed");
}

/* ---------- helpers ---------- */
function parseJsonArray(text) {
  if (!text) return [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return [];
  }
}

function fallbackValues(fields, profile) {
  const get = (rx) => {
    const m = (profile || "").match(rx);
    return m ? m[1].trim() : null;
  };
  const name = get(/name\s*[:\-]\s*([^\n,]+)/i) || "Alex Doe";
  const email = get(/email\s*[:\-]\s*([^\s,]+)/i) || "alex.doe@example.com";
  const phone = get(/phone\s*[:\-]\s*([^\n,]+)/i) || "+1 555 010 1234";
  const address = get(/address\s*[:\-]\s*([^\n]+)/i) || "1 Example Street";
  return fields.map((f) => {
    const lab = (f.label || "").toLowerCase();
    let value = "";
    if (f.type === "checkbox") value = false;
    else if (f.type === "email" || lab.includes("email")) value = email;
    else if (f.type === "tel" || lab.includes("phone")) value = phone;
    else if (lab.includes("name")) value = name;
    else if (lab.includes("address")) value = address;
    else if (f.type === "number") value = "1";
    else if (f.type === "date") value = "2000-01-01";
    else if (f.type === "url") value = "https://example.com";
    else if ((f.type === "select" || f.type === "radio") && f.options?.length)
      value = f.options[0].text || f.options[0].value;
    else value = "Sample answer";
    return { id: f.id, value };
  });
}

/* ---------- message router ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "AI_FILL") {
    (async () => {
      const { fields = [], profile = "" } = msg.payload || {};
      try {
        const prompt = buildFillPrompt(msg.payload);
        const text = await callAgent(prompt, { mode: "single" });
        const parsed = parseJsonArray(text);
        if (Array.isArray(parsed) && parsed.length) {
          const known = new Set(fields.map((f) => f.id));
          const clean = parsed.filter((v) => v && known.has(v.id));
          const have = new Set(clean.map((v) => v.id));
          const missing = fields.filter((f) => !have.has(f.id));
          const merged = clean.concat(fallbackValues(missing, profile));
          sendResponse({ ok: true, values: merged, source: "agent" });
          return;
        }
        sendResponse({
          ok: true,
          values: fallbackValues(fields, profile),
          source: "fallback",
          warning: "Agent returned unparseable text; used fallback.",
        });
      } catch (e) {
        sendResponse({
          ok: true,
          values: fallbackValues(fields, profile),
          source: "fallback",
          warning: `Agent unreachable (${String(e.message || e)}); used fallback.`,
        });
      }
    })();
    return true;
  }

  if (msg?.type === "AI_CHAT") {
    (async () => {
      const { messages = [], profile = "" } = msg.payload || {};
      const history = messages
        .slice(0, -1)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");
      const lastUser = messages[messages.length - 1]?.content || "";
      const userMessage = history
        ? `Previous conversation:\n${history}\n\nUser: ${lastUser}\nAssistant:`
        : lastUser;
      const system = [
        "You are Umabonakude, a friendly AI assistant focused on accessibility,",
        "form-filling, and helping users get things done on the web.",
        "Reply in a clear, concise, conversational tone.",
        profile?.trim() ? `\nUSER PROFILE:\n${profile.trim()}` : "",
      ].join(" ");
      try {
        const text = await callAgent(userMessage, { mode: "chat", system });
        const reply = String(text || "").replace(/^Assistant:\s*/i, "").trim();
        sendResponse({ ok: true, reply: reply || "(empty response)" });
      } catch (e) {
        sendResponse({ ok: false, error: `Agent unreachable: ${String(e.message || e)}` });
      }
    })();
    return true;
  }

  if (msg?.type === "GET_ENDPOINT") {
    getBase().then((base) => sendResponse({ ok: true, endpoint: base }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => console.log("Umabonakude installed."));
