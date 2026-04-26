/* Umabonakude popup controller */
const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const resultsEl = $("#results");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(text, kind = "info") {
  statusEl.textContent = text;
  statusEl.style.color =
    kind === "error" ? "#ff6b8a" : kind === "ok" ? "#2dd4bf" : "";
}

function renderResults(items) {
  resultsEl.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    const a = document.createElement("span");
    a.className = "label";
    a.textContent = it.label || it.name || it.selector || "field";
    const b = document.createElement("span");
    b.className = "val";
    b.textContent = it.value ?? it.type ?? "";
    li.append(a, b);
    resultsEl.appendChild(li);
  }
}

async function sendToTab(tabId, msg) {
  // Make sure content script is present, then send.
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

/* ---------- profile ---------- */
async function loadProfile() {
  const { profile = "" } = await chrome.storage.local.get("profile");
  $("#profile").value = profile;
}
$("#save-profile").addEventListener("click", async () => {
  await chrome.storage.local.set({ profile: $("#profile").value });
  setStatus("Profile saved.", "ok");
});

/* ---------- endpoint ---------- */
async function loadEndpoint() {
  const { agent_endpoint = "" } = await chrome.storage.local.get("agent_endpoint");
  const el = document.getElementById("endpoint");
  if (el) el.value = agent_endpoint;
}
document.getElementById("save-endpoint")?.addEventListener("click", async () => {
  const val = document.getElementById("endpoint").value.trim();
  await chrome.storage.local.set({ agent_endpoint: val });
  setStatus(val ? `Endpoint saved: ${val}` : "Endpoint cleared (using default).", "ok");
});
loadEndpoint();

/* ---------- scan ---------- */
$("#scan").addEventListener("click", async () => {
  setStatus("Scanning page for form fields…");
  resultsEl.innerHTML = "";
  const tab = await getActiveTab();
  try {
    const res = await sendToTab(tab.id, { type: "SCAN" });
    if (!res?.ok) throw new Error(res?.error || "Scan failed");
    setStatus(`Found ${res.fields.length} field(s).`, "ok");
    renderResults(res.fields.map((f) => ({ label: f.label, value: f.type })));
  } catch (e) {
    setStatus(e.message, "error");
  }
});

/* ---------- fill ---------- */
$("#fill").addEventListener("click", async () => {
  const fillBtn = $("#fill");
  fillBtn.disabled = true;
  setStatus("Scanning…");
  resultsEl.innerHTML = "";
  const tab = await getActiveTab();
  try {
    const scan = await sendToTab(tab.id, { type: "SCAN" });
    if (!scan?.ok) throw new Error(scan?.error || "Scan failed");
    if (scan.fields.length === 0) throw new Error("No fields found on this page.");
    setStatus(`Asking AI to fill ${scan.fields.length} field(s)…`);

    const { profile = "" } = await chrome.storage.local.get("profile");

    const ai = await chrome.runtime.sendMessage({
      type: "AI_FILL",
      payload: {
        url: tab.url,
        title: tab.title,
        profile,
        fields: scan.fields.map((f) => ({
          id: f.id,
          label: f.label,
          type: f.type,
          name: f.name,
          placeholder: f.placeholder,
          options: f.options,
        })),
      },
    });
    if (!ai?.ok) throw new Error(ai?.error || "Agent failed");

    const apply = await sendToTab(tab.id, { type: "APPLY", values: ai.values });
    if (!apply?.ok) throw new Error(apply?.error || "Apply failed");

    setStatus(`Filled ${apply.applied} of ${scan.fields.length} fields.`, "ok");
    renderResults(
      ai.values.map((v) => ({
        label: scan.fields.find((f) => f.id === v.id)?.label || v.id,
        value: String(v.value).slice(0, 40),
      }))
    );
  } catch (e) {
    setStatus(e.message, "error");
  } finally {
    fillBtn.disabled = false;
  }
});

/* ---------- audit ---------- */
$("#audit").addEventListener("click", async () => {
  setStatus("Running accessibility audit…");
  resultsEl.innerHTML = "";
  const tab = await getActiveTab();
  try {
    const res = await sendToTab(tab.id, { type: "AUDIT" });
    if (!res?.ok) throw new Error(res?.error || "Audit failed");
    const issues = res.issues;
    setStatus(
      issues.length
        ? `${issues.length} accessibility issue(s) found.`
        : "No major issues detected. ✨",
      issues.length ? "error" : "ok"
    );
    renderResults(issues.map((i) => ({ label: i.rule, value: i.detail })));
  } catch (e) {
    setStatus(e.message, "error");
  }
});

loadProfile();

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById("tab-tools").classList.toggle("hidden", tab !== "tools");
    document.getElementById("tab-chat").classList.toggle("hidden", tab !== "chat");
    if (tab === "chat") $("#chat-input").focus();
  });
});

/* ---------- chat ---------- */
const CHAT_KEY = "chat_history";
let chatHistory = [];

function renderChat() {
  const log = $("#chat-log");
  log.innerHTML = "";
  if (!chatHistory.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "Say hi to the agent 👋";
    log.appendChild(empty);
    return;
  }
  for (const m of chatHistory) {
    const div = document.createElement("div");
    div.className = `chat-msg ${m.role}${m.error ? " error" : ""}`;
    div.textContent = m.content;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

async function loadChat() {
  const data = await chrome.storage.local.get(CHAT_KEY);
  chatHistory = Array.isArray(data[CHAT_KEY]) ? data[CHAT_KEY] : [];
  renderChat();
}

async function saveChat() {
  await chrome.storage.local.set({ [CHAT_KEY]: chatHistory.slice(-40) });
}

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  const sendBtn = $("#chat-send");
  sendBtn.disabled = true;
  input.value = "";

  chatHistory.push({ role: "user", content: text });
  renderChat();

  // Typing indicator
  chatHistory.push({ role: "agent", content: "…", pending: true });
  renderChat();

  try {
    const { profile = "" } = await chrome.storage.local.get("profile");
    const messagesForAgent = chatHistory
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

    const res = await chrome.runtime.sendMessage({
      type: "AI_CHAT",
      payload: { messages: messagesForAgent, profile },
    });

    chatHistory = chatHistory.filter((m) => !m.pending);
    if (res?.ok) {
      chatHistory.push({ role: "agent", content: res.reply });
    } else {
      chatHistory.push({
        role: "agent",
        content: res?.error || "Something went wrong.",
        error: true,
      });
    }
    await saveChat();
    renderChat();
  } catch (err) {
    chatHistory = chatHistory.filter((m) => !m.pending);
    chatHistory.push({ role: "agent", content: String(err.message || err), error: true });
    renderChat();
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

$("#chat-clear").addEventListener("click", async () => {
  chatHistory = [];
  await saveChat();
  renderChat();
});

$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#chat-form").requestSubmit();
  }
});

loadChat();