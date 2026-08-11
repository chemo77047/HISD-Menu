// SNAP Agent - School Nutrition AI Purchasing Agent
// popup.js - Handles scan button and displays flagged items + reminders

const API_KEY = "YOUR_OPENAI_API_KEY_HERE";   // ← Change this
const SPREADSHEET_ID = "1NOtQu0_rErgdA_5IlFMaA59Po6mVhRLU-L7Lhup0nZA";

// Opens the menu window: the delivery date and the next five school days, in a
// window of its own so it can sit beside the order screen. The order context is
// read here, while the popup still has access to the active tab, and handed over
// through session storage.
document.getElementById("menuBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  statusEl.style.color = "#3a7030";
  statusEl.textContent = "Reading the order...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const context = await chrome.tabs.sendMessage(tab.id, { action: "getOrderContext" });

    if (!context || !context.schoolName) {
      statusEl.style.color = "#d32f2f";
      statusEl.textContent = "No order found on this page. Open a PrimeroEdge order and refresh.";
      return;
    }

    await chrome.storage.session.set({ "snap.orderContext": { ...context, tabId: tab.id } });
    await chrome.windows.create({
      url: chrome.runtime.getURL("menu.html"),
      type: "popup",
      width: 760,
      height: 900,
    });
    statusEl.textContent = "";
    window.close();
  } catch (err) {
    statusEl.style.color = "#d32f2f";
    statusEl.textContent = "Cannot read the page. Try refreshing it. (" + err.message + ")";
  }
});

document.getElementById("scanBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  const flagsEl = document.getElementById("flags");
  const remindersEl = document.getElementById("reminders");

  statusEl.textContent = "Scanning order...";
  statusEl.style.color = "#3a7030";
  flagsEl.innerHTML = "";
  remindersEl.innerHTML = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.tabs.sendMessage(tab.id, { action: "scanOrder", apiKey: API_KEY, spreadsheetId: SPREADSHEET_ID }, (res) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Cannot connect to page. Try refreshing the page.";
        statusEl.style.color = "#d32f2f";
        return;
      }

      res = res || {};

      if (res.error) {
        statusEl.textContent = res.error;
        statusEl.style.color = "#d32f2f";
        return;
      }

      const hasFlags = res.flags && res.flags.length > 0;
      const hasReminders = res.reminders && res.reminders.length > 0;

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
        statusEl.innerHTML = `<strong style="color:#d32f2f">${res.flags.length} issue${res.flags.length > 1 ? "s" : ""} found</strong>` +
          (hasReminders ? ` + <strong style="color:#1565c0">${res.reminders.length} reminder${res.reminders.length > 1 ? "s" : ""}</strong>` : "") +
          `<br><span style="font-size:11px;color:#666">${res.schoolName} — ${res.itemCount} items scanned${rulesInfo}</span>`;
      } else if (hasReminders) {
        statusEl.innerHTML = `<span style="color:#3a7030">No issues found</span>` +
          ` — <strong style="color:#1565c0">${res.reminders.length} reminder${res.reminders.length > 1 ? "s" : ""}</strong>` +
          `<br><span style="font-size:11px;color:#666">${res.schoolName} — ${res.itemCount} items scanned${rulesInfo}</span>`;
      } else {
        statusEl.innerHTML = `<span style="color:#3a7030">No issues found</span>` +
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
            chrome.tabs.sendMessage(tab.id, { action: "highlightRow", index: f.index });
          });

          // Ignore button removes this specific alert
          div.querySelector(".ignore-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            chrome.tabs.sendMessage(tab.id, { action: "ignoreRow", index: f.index });
            div.style.opacity = "0";
            div.style.transform = "translateX(20px)";
            setTimeout(() => div.remove(), 200);
          });

          flagsEl.appendChild(div);
        });
      }

      // Display reminders
      if (hasReminders) {
        const headerDiv = document.createElement("div");
        headerDiv.className = "reminder-header";
        headerDiv.textContent = "Reminders";
        remindersEl.appendChild(headerDiv);

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

          remindersEl.appendChild(div);
        });
      }
    });
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    statusEl.style.color = "#d32f2f";
  }
});
