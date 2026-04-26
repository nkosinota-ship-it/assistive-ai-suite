/* Umabonakude background service worker — talks to the HF Space agent. */

// NOTE: correct subdomain has the "k" (UMABONAKUDE).
const HF_SPACE = "https://sphahh222-umabonakude.hf.space";
// Gradio 6.x exposes /gradio_api/call/<api_name>; the Space uses ChatInterface → "respond".
const FN_NAME = "respond";

/** Build the prompt the agent will see. */
function buildPrompt({ url, title, profile, fields }) {
  const fieldList = fields
    .map((f, i) => {
      const opts =
        f.options && f.options.length
          ? ` | options: ${f.options
              .map((o) => o.text || o.value)
              .slice(0, 8)
              .join(", ")}`
          : "";
      return `${i + 1}. id="${f.id}" label="${f.label}" type=${f.type}${opts}`;
    })
    .join("\n");

  return [
    "You are an AI form-filling assistant. Generate realistic, sensible values",
    "for each form field below using the user profile when relevant.",
    "",
    "USER PROFILE:",
    profile?.trim() ? profile.trim() : "(no profile provided — use plausible generic values)",
    "",
    `PAGE: ${title || ""} — ${url || ""}`,
    "",
    "FIELDS:",
    fieldList,
    "",
    "Respond ONLY with a compact JSON array, one object per field:",
    '[{"id":"<id>","value":"<string-or-boolean>"}, ...]',
    "For checkboxes return true/false. For selects/radios return one of the option texts.",
    "Do not include any commentary, only the JSON.",
  ].join("\n");
}

/** Read a Gradio SSE stream from /gradio_api/call/<fn>/<event_id>. */
async function readGradioStream(eventId) {
  const r = await fetch(`${HF_SPACE}/gradio_api/call/${FN_NAME}/${eventId}`);
  if (!r.ok || !r.body) throw new Error(`Stream HTTP ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastEvent = "";
  let lastDataRaw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line.startsWith("event:")) lastEvent = line.slice(6).trim();
      else if (line.startsWith("data:")) lastDataRaw = line.slice(5).trim();
      if (lastEvent === "complete" && lastDataRaw) {
        try {
          const parsed = JSON.parse(lastDataRaw);
          const out = Array.isArray(parsed) ? parsed[0] : parsed;
          return typeof out === "string" ? out : JSON.stringify(out);
        } catch {
          return lastDataRaw;
        }
      }
      if (lastEvent === "error") {
        throw new Error(`Agent error: ${lastDataRaw || "unknown"}`);
      }
    }
  }
  throw new Error("Stream ended without 'complete' event");
}

/**
 * Call the Space's ChatInterface "respond" endpoint.
 * Signature: (message, system_message, max_tokens, temperature, top_p)
 */
async function callAgent(prompt, systemMessage = "You are a helpful assistant.") {
  const r = await fetch(`${HF_SPACE}/gradio_api/call/${FN_NAME}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [prompt, systemMessage, 512, 0.7, 0.95],
    }),
  });
  if (!r.ok) throw new Error(`POST ${FN_NAME} → HTTP ${r.status}`);
  const j = await r.json();
  const eventId = j?.event_id;
  if (!eventId) throw new Error("No event_id returned by Space");
  return await readGradioStream(eventId);
}

/** Extract the first JSON array from a free-form string. */
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

/** Fallback values if the agent fails or returns junk. */
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "AI_FILL") {
    (async () => {
      const { fields = [], profile = "" } = msg.payload || {};
      try {
        const prompt = buildPrompt(msg.payload);
        const text = await callAgent(
          prompt,
          "You are a precise form-filling assistant. Reply ONLY with the requested JSON array."
        );
        const parsed = parseJsonArray(text);
        if (Array.isArray(parsed) && parsed.length) {
          // Keep only known ids
          const known = new Set(fields.map((f) => f.id));
          const clean = parsed.filter((v) => v && known.has(v.id));
          // Fill any missing ids with fallback
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
    return true; // async
  }

  if (msg?.type === "AI_CHAT") {
    (async () => {
      const { messages = [], profile = "" } = msg.payload || {};
      // Build a single user message (the Space's /respond endpoint takes one
      // message + a system prompt; we fold conversation history into the message).
      const history = messages
        .slice(0, -1)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");
      const lastUser = messages[messages.length - 1]?.content || "";
      const userMessage = history
        ? `Previous conversation:\n${history}\n\nNew message from user:\n${lastUser}`
        : lastUser;
      const systemMessage = [
        "You are Umabonakude, a friendly AI assistant focused on accessibility,",
        "form-filling, and helping users get things done on the web.",
        "Reply in a clear, concise, conversational tone.",
        profile?.trim() ? `\nUSER PROFILE:\n${profile.trim()}` : "",
      ].join(" ");
      try {
        const text = await callAgent(userMessage, systemMessage);
        const reply = String(text || "").replace(/^Assistant:\s*/i, "").trim();
        sendResponse({ ok: true, reply: reply || "(empty response)" });
      } catch (e) {
        sendResponse({
          ok: false,
          error: `Agent unreachable: ${String(e.message || e)}`,
        });
      }
    })();
    return true; // async
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("Umabonakude installed.");
});