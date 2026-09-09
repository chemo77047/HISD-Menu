// SNAP Agent - School Nutrition AI Purchasing Agent
// popup.js - Handles scan button and displays flagged items + reminders

// The key and the sheet id live in config.js, which the service worker reads too.
import { KEY_IS_SET } from "./config.js";

const SCAN_KEY = "snap.scan";

const statusEl = () => document.getElementById("status");
const flagsEl = () => document.getElementById("flags");
const remindersEl = () => document.getElementById("reminders");

function setStatus(text, colour) {
  statusEl().style.color = colour;
  statusEl().textContent = text;
}

// Opens the menu window: the delivery date and the next five school days, in a
// window of its own so it can sit beside the order screen. Only the tab number is
// handed over; the window reads the order itself, so the popup never waits on the
// page and there is nothing to sit and watch here. Pressing the button again
// brings the existing window forward instead of opening a second one.
document.getElementById("menuBtn").addEventListener("click", async () => {
  setStatus("Opening the menu...", "#3a7030");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.storage.session.set({ "snap.orderContext": { tabId: tab.id } });
    await chrome.runtime.sendMessage({ action: "openMenuWindow" });
    setStatus("", "#3a7030");
    window.close();
  } catch (err) {
    setStatus("Could not open the menu window. (" + err.message + ")", "#d32f2f");
  }
});

// The scan itself runs in the service worker, so clicking away from this popup -
// onto the menu window, for instance - no longer abandons it half way. All this
// does is ask for it and show whatever comes back, whether that is now or the
// next time the popup is opened.
document.getElementById("scanBtn").addEventListener("click", async () => {
  if (!KEY_IS_SET) {
    setStatus("No OpenAI key yet: paste it into API_KEY at the top of config.js. "
      + "The Show Menu button works without it.", "#d32f2f");
    return;
  }

  flagsEl().innerHTML = "";
  remindersEl().innerHTML = "";
  setStatus("Scanning order...", "#3a7030");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({ action: "scanOrder", tabId: tab.id });
    renderScan(result, tab.id);
  } catch (err) {
    setStatus("Error: " + err.message, "#d32f2f");
  }
});

// A scan that finished while the popup was shut is waiting in session storage,
// and one still running will announce itself when it is done.
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "scanFinished") renderScan(message.result, message.tabId);
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
  if (!stored || stored.tabId !== tab.id) return;

  if (stored.state === "running") {
    setStatus("Scanning order... (it carries on if you close this)", "#3a7030");
  } else if (stored.result) {
    renderScan(stored.result, tab.id);
  }
})();

function renderScan(res, tabId) {
  res = res || {};

  if (res.error) {
    setStatus(res.error, "#d32f2f");
    return;
  }

  const hasFlags = res.flags && res.flags.length > 0;
  const hasReminders = res.reminders && res.reminders.length > 0;

  flagsEl().innerHTML = "";
  remindersEl().innerHTML = "";

  // Build rules info string
  let rulesInfo = "";
  if (res.rulesLoaded) {
    const parts = [];
    if (res.rulesLoaded.general !== "none") parts.push(res.rulesLoaded.general);
    if (res.rulesLoaded.school !== "none") parts.push(res.rulesLoaded.school);
    rulesInfo = parts.length > 0 ? ` | Rules: ${parts.join(" + ")}` : "";
  }

  // Status line
  if (hasFlags) {
    statusEl().innerHTML = `<strong style="color:#d32f2f">${res.flags.length} issue${res.flags.length > 1 ? "s" : ""} found</strong>` +
      (hasReminders ? ` + <strong style="color:#1565c0">${res.reminders.length} reminder${res.reminders.length > 1 ? "s" : ""}</strong>` : "") +
      `<br><span style="font-size:11px;color:#666">${res.schoolName} — ${res.itemCount} items scanned${rulesInfo}</span>`;
  } else if (hasReminders) {
    statusEl().innerHTML = `<span style="color:#3a7030">No issues found</span>` +
      ` — <strong style="color:#1565c0">${res.reminders.length} reminder${res.reminders.length > 1 ? "s" : ""}</strong>` +
      `<br><span style="font-size:11px;color:#666">${res.schoolName} — ${res.itemCount} items scanned${rulesInfo}</span>`;
  } else {
    statusEl().innerHTML = `<span style="color:#3a7030">No issues found</span>` +
      `<br><span style="font-size:11px;color:#666">${res.schoolName} — ${res.itemCount} items scanned${rulesInfo}</span>`;
  }

  // Display flags with Ignore button
  if (hasFlags) {
    res.flags.forEach(f => {
      const div = document.createElement("div");
      div.className = "flag" + (f.severity === "orange" ? " orange" : "");
      div.innerHTML = `
        <div class="flag-content">
          <div class="flag-item">${f.item}</div>
          <div class="flag-reason">${f.reason}</div>
        </div>
        <button class="ignore-btn" title="Ignore this alert">Ignore</button>
      `;

      // Click flag content to scroll to row
      div.querySelector(".flag-content").addEventListener("click", () => {
        chrome.tabs.sendMessage(tabId, { action: "highlightRow", index: f.index });
      });

      // Ignore button removes this specific alert
      div.querySelector(".ignore-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        chrome.tabs.sendMessage(tabId, { action: "ignoreRow", index: f.index });
        div.style.opacity = "0";
        div.style.transform = "translateX(20px)";
        setTimeout(() => div.remove(), 200);
      });

      flagsEl().appendChild(div);
    });
  }

  // Display reminders
  if (hasReminders) {
    const headerDiv = document.createElement("div");
    headerDiv.className = "reminder-header";
    headerDiv.textContent = "Reminders";
    remindersEl().appendChild(headerDiv);

    res.reminders.forEach(item => {
      const div = document.createElement("div");
      div.className = "reminder";
      div.innerHTML = `
        <div class="reminder-content">
          <div class="reminder-item">Are you sure you don't need ${item}?</div>
        </div>
        <button class="ignore-btn reminder-ignore" title="Ignore this reminder">Ignore</button>
      `;

      div.querySelector(".ignore-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        div.style.opacity = "0";
        div.style.transform = "translateX(20px)";
        setTimeout(() => div.remove(), 200);
      });

      remindersEl().appendChild(div);
    });
  }
}
