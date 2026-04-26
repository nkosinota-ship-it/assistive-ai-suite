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