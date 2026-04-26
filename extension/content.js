/* Umabonakude content script — DOM scan, fill, accessibility audit */
(() => {
  if (window.__umabonakude_loaded__) return;
  window.__umabonakude_loaded__ = true;

  const FIELD_SELECTOR =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([disabled]), textarea:not([disabled]), select:not([disabled])';

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0")
      return false;
    return true;
  }

  function labelFor(el) {
    // 1) <label for="id">
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    // 2) wrapping <label>
    const wrap = el.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    // 3) aria-label / aria-labelledby
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    const ll = el.getAttribute("aria-labelledby");
    if (ll) {
      const ref = document.getElementById(ll);
      if (ref) return ref.textContent.trim();
    }
    // 4) placeholder / name / title
    return (
      el.placeholder ||
      el.getAttribute("title") ||
      el.name ||
      el.id ||
      el.tagName.toLowerCase()
    );
  }

  function uniqueId(el, idx) {
    if (!el.dataset.umaId) el.dataset.umaId = "uma_" + idx + "_" + Date.now();
    return el.dataset.umaId;
  }

  function scan() {
    const all = Array.from(document.querySelectorAll(FIELD_SELECTOR)).filter(
      isVisible
    );
    return all.map((el, i) => {
      const id = uniqueId(el, i);
      const tag = el.tagName.toLowerCase();
      const type =
        tag === "select"
          ? "select"
          : tag === "textarea"
          ? "textarea"
          : (el.type || "text").toLowerCase();
      const field = {
        id,
        tag,
        type,
        name: el.name || "",
        label: (labelFor(el) || "").slice(0, 200),
        placeholder: el.placeholder || "",
      };
      if (tag === "select") {
        field.options = Array.from(el.options).map((o) => ({
          value: o.value,
          text: o.text,
        }));
      }
      if (type === "radio") {
        // group label
        field.name = el.name;
        field.options = Array.from(
          document.querySelectorAll(
            `input[type="radio"][name="${CSS.escape(el.name)}"]`
          )
        ).map((r) => ({ value: r.value, text: labelFor(r) }));
      }
      return field;
    });
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fillField(el, value) {
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (tag === "select") {
      const opt = Array.from(el.options).find(
        (o) =>
          o.value === String(value) ||
          o.text.toLowerCase() === String(value).toLowerCase()
      );
      if (opt) {
        el.value = opt.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }
    if (type === "checkbox") {
      const want =
        value === true || /^(true|yes|on|1|checked)$/i.test(String(value));
      el.checked = want;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (type === "radio") {
      const group = document.querySelectorAll(
        `input[type="radio"][name="${CSS.escape(el.name)}"]`
      );
      const target = Array.from(group).find(
        (r) =>
          r.value === String(value) ||
          (labelFor(r) || "").toLowerCase() === String(value).toLowerCase()
      );
      if (target) {
        target.checked = true;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }
    setNativeValue(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function applyValues(values) {
    let applied = 0;
    for (const { id, value } of values) {
      if (value === null || value === undefined || value === "") continue;
      const el = document.querySelector(`[data-uma-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      try {
        if (fillField(el, value)) {
          el.style.transition = "outline 0.2s";
          el.style.outline = "2px solid #2dd4bf";
          setTimeout(() => (el.style.outline = ""), 1200);
          applied++;
        }
      } catch (_) {}
    }
    return applied;
  }

  function audit() {
    const issues = [];
    document.querySelectorAll("img").forEach((img) => {
      if (!img.alt && !img.getAttribute("aria-label")) {
        issues.push({
          rule: "Image missing alt",
          detail: (img.src || "").split("/").pop().slice(0, 60),
        });
      }
    });
    document.querySelectorAll(FIELD_SELECTOR).forEach((el) => {
      if (!isVisible(el)) return;
      const lab = labelFor(el);
      if (!lab || lab === el.tagName.toLowerCase()) {
        issues.push({
          rule: "Form field has no label",
          detail: el.name || el.id || el.tagName.toLowerCase(),
        });
      }
    });
    document.querySelectorAll("a").forEach((a) => {
      const txt = (a.textContent || "").trim();
      if (!txt && !a.getAttribute("aria-label")) {
        issues.push({ rule: "Link with no text", detail: a.href.slice(0, 60) });
      }
    });
    const h1s = document.querySelectorAll("h1");
    if (h1s.length === 0) {
      issues.push({ rule: "No <h1> on page", detail: "Add a primary heading" });
    } else if (h1s.length > 1) {
      issues.push({
        rule: "Multiple <h1>s",
        detail: `${h1s.length} found, prefer 1`,
      });
    }
    if (!document.documentElement.lang) {
      issues.push({ rule: "Missing <html lang>", detail: "Set document language" });
    }
    return issues.slice(0, 50);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg?.type === "SCAN") {
        sendResponse({ ok: true, fields: scan() });
      } else if (msg?.type === "APPLY") {
        sendResponse({ ok: true, applied: applyValues(msg.values || []) });
      } else if (msg?.type === "AUDIT") {
        sendResponse({ ok: true, issues: audit() });
      } else {
        sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  });
})();