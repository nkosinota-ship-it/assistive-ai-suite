/* Umabonakude background service worker — talks to the HF Space agent. */

const HF_SPACE = "https://sphahh222-umabonaude.hf.space";
const FN_NAME = "generate_text"; // exposed Gradio function

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

/** Try Gradio /run/predict, then /api/predict, then /call/<fn>. Return text. */
async function callAgent(prompt) {
  const endpoints = [
    { url: `${HF_SPACE}/run/${FN_NAME}`, body: { data: [prompt] } },
    { url: `${HF_SPACE}/run/predict`, body: { data: [prompt], fn_index: 0 } },
    { url: `${HF_SPACE}/api/predict`, body: { data: [prompt], fn_index: 0 } },
  ];
  let lastErr = null;
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ep.body),
      });
      if (!r.ok) {
        lastErr = new Error(`${ep.url} → ${r.status}`);
        continue;
      }
      const j = await r.json();
      const data = j?.data ?? j?.output?.data ?? j;
      const text = Array.isArray(data) ? data[0] : data;
      if (typeof text === "string" && text.length) return text;
      lastErr = new Error("Empty response");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All agent endpoints failed");
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
        const text = await callAgent(prompt);
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
      const history = messages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");
      const prompt = [
        "You are Umabonakude, a friendly AI assistant focused on accessibility,",
        "form-filling, and helping users get things done on the web.",
        "Reply in a clear, concise, conversational tone.",
        "",
        profile?.trim() ? `USER PROFILE:\n${profile.trim()}\n` : "",
        "CONVERSATION:",
        history,
        "Assistant:",
      ]
        .filter(Boolean)
        .join("\n");
      try {
        const text = await callAgent(prompt);
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