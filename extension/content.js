// SNAP Agent - School Nutrition AI Purchasing Agent
// content.js - Runs on Primero Edge pages, scans orders, and highlights issues

let currentHighlights = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "scanOrder") {
    scanOrder(msg.apiKey, msg.spreadsheetId).then(sendResponse);
    return true;
  }
  if (msg.action === "highlightRow") {
    highlightSingleRow(msg.index);
  }
  if (msg.action === "ignoreRow") {
    clearSingleHighlight(msg.index);
  }
  if (msg.action === "clearAll") {
    clearHighlights();
  }
  if (msg.action === "getOrderContext") {
    sendResponse(getOrderContext());
  }
});

// --- Order context for the menu window ------------------------------------
// The school, the delivery date and the ordered lines. The delivery date is the
// day the food arrives and so the day it is served; the order date is only when
// the order was keyed, and is reported for reference.

function firstText(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const text = (el.value !== undefined && el.value !== "" ? el.value : el.innerText || "").trim();
    if (text.length > 1) return text;
  }
  return "";
}

function getOrderContext() {
  const schoolName = firstText([
    "span[id*='ConfirmShipToSiteLabel']",
    "span[id*='ShipToSite']",
    "span[id*='SiteName']",
    "span[id*='ShipTo']"
  ]);

  const deliveryDate = normalizeDate(firstText([
    "span[id*='ConfirmDeliveryDateLabel']",
    "span[id*='DeliveryDateLabel']",
    "input[id*='deliveryDateCalendar_dateInput']"
  ]));

  const orderDate = normalizeDate(firstText([
    "span[id*='ConfirmOrderDateLabel']",
    "span[id*='OrderDateLabel']",
    "input[id*='orderDateCalendar_dateInput']"
  ]));

  const items = [];
  document.querySelectorAll("span[id*='itemDescriptionLabel']").forEach((el, index) => {
    const text = el.innerText.trim();
    if (text) items.push({ index, item: text });
  });

  return { schoolName, deliveryDate, orderDate, items, url: location.href };
}

// m/d/yyyy as rendered by PrimeroEdge, to yyyy-mm-dd. Built by hand rather than
// through Date parsing, which reads a bare m/d/yyyy as UTC and can land on the
// previous day.
function normalizeDate(text) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text || "");
  if (!m) return null;
  const [, month, day, year] = m;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function scanOrder(apiKey, spreadsheetId) {
  clearHighlights();

  // Find the order table FIRST
  const tableId = "ctl00_UserContentArea_Wizard1_ConfirmOrderLinesRadGrid_ctl00";
  const table = document.getElementById(tableId);

  let orderItems = [];

  if (table) {
    const rows = table.querySelectorAll("tr.rgRow, tr.rgAltRow");
    rows.forEach((row, idx) => {
      const descEl = row.querySelector("span[id*='itemDescriptionLabel']");
      const qtyEl = row.querySelector("span[id$='wholeUnits']");
      const unitEl = row.querySelector("span[id*='wholeUnitDesc']");
      if (descEl) {
        orderItems.push({
          index: idx,
          item: descEl.innerText.trim(),
          quantity: parseFloat(qtyEl ? qtyEl.innerText : 0) || 0,
          unit: unitEl ? unitEl.innerText.trim() : "Case",
          element: row
        });
      }
    });
  }

  // Fallback: broader selectors
  if (orderItems.length === 0) {
    const fallbackRows = document.querySelectorAll(".RadGrid tr.rgRow, .RadGrid tr.rgAltRow");
    fallbackRows.forEach((row, idx) => {
      const descEl = row.querySelector("span[id*='itemDescriptionLabel']");
      const qtyEl = row.querySelector("span[id$='wholeUnits']");
      const unitEl = row.querySelector("span[id*='wholeUnitDesc']");
      if (descEl) {
        orderItems.push({
          index: idx,
          item: descEl.innerText.trim(),
          quantity: parseFloat(qtyEl ? qtyEl.innerText : 0) || 0,
          unit: unitEl ? unitEl.innerText.trim() : "Case",
          element: row
        });
      }
    });
  }

  if (orderItems.length === 0) {
    return {
      flags: [],
      reminders: [],
      error: "Could not find a Primero order, try refreshing the page."
    };
  }

  // Detect school name from the Ship-To site label
  let schoolName = "";
  const schoolSelectors = [
    "span[id*='ConfirmShipToSiteLabel']",
    "span[id*='ShipToSite']",
    "span[id*='SiteName']",
    "span[id*='ShipTo']"
  ];
  for (const sel of schoolSelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 2) {
      schoolName = el.innerText.trim();
      break;
    }
  }

  if (!schoolName) {
    schoolName = "Unknown School";
  }

  // Detect storage categories
  let storageCategories = [];
  if (table) {
    const groupRows = table.querySelectorAll("td.rgGroupCol + td p");
    groupRows.forEach(p => storageCategories.push(p.innerText.trim()));
  }

  // Determine school level from name
  let schoolLevel = "";
  const nameLower = schoolName.toLowerCase();
  if (nameLower.includes(" hs") || nameLower.includes("high")) {
    schoolLevel = "High Schools";
  } else if (nameLower.includes(" ms") || nameLower.includes("middle")) {
    schoolLevel = "Middle Schools";
  } else if (nameLower.includes(" es") || nameLower.includes("elem")) {
    schoolLevel = "Elem Schools";
  }

  // Fetch rules from Google Sheets — both general and school-specific
  const baseUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv`;

  let generalRules = { restrict: [], remind: [] };
  let schoolRules = { restrict: [], remind: [] };

  // Fetch general rules for school level
  if (schoolLevel) {
    try {
      const res = await fetch(`${baseUrl}&sheet=${encodeURIComponent(schoolLevel)}`);
      const text = await res.text();
      if (text.trim()) {
        generalRules = parseCSVRules(text);
      }
    } catch (e) {
      console.error("[SNAP] Failed to fetch general rules", e);
    }
  }

  // Fetch school-specific rules
  try {
    const res = await fetch(`${baseUrl}&sheet=${encodeURIComponent(schoolName)}`);
    const text = await res.text();
    if (text.trim()) {
      schoolRules = parseCSVRules(text);
    }
  } catch (e) {
    console.error("[SNAP] Failed to fetch school rules", e);
  }

  // Combine restrict rules for AI prompt
  let allRestrictRules = "";
  if (generalRules.restrict.length > 0) {
    allRestrictRules += `GENERAL RULES (${schoolLevel}):\n${generalRules.restrict.join("\n")}\n\n`;
  }
  if (schoolRules.restrict.length > 0) {
    allRestrictRules += `SCHOOL-SPECIFIC RULES (${schoolName}):\n${schoolRules.restrict.join("\n")}\n\n`;
  }

  // Combine reminder items
  const allReminders = [...generalRules.remind, ...schoolRules.remind];

  if (!allRestrictRules.trim() && allReminders.length === 0) {
    return {
      flags: [],
      reminders: [],
      error: `No rules found for "${schoolName}" or "${schoolLevel}" in the Google Sheet. Make sure there is a tab named "${schoolName}" with rules.`,
      schoolName: schoolName,
      itemCount: orderItems.length
    };
  }

  // Check reminders — which reminder items are NOT in the order
  const orderItemsLower = orderItems.map(item => item.item.toLowerCase());
  const missingReminders = [];

  allReminders.forEach(reminderItem => {
    const reminderLower = reminderItem.toLowerCase();
    // Check if any order item contains the reminder keyword
    const found = orderItemsLower.some(orderItem => {
      // Match if order item contains the reminder text or vice versa
      return orderItem.includes(reminderLower) || reminderLower.split(/\s+/).every(word => orderItem.includes(word));
    });
    if (!found) {
      missingReminders.push(reminderItem);
    }
  });

  // Build the AI prompt for restrict rules
  let flags = [];

  if (allRestrictRules.trim()) {
    const orderList = orderItems
      .map((item, i) => `${i}. ${item.item} — ${item.quantity} ${item.unit}`)
      .join("\n");

    const prompt = `You are a strict school nutrition services order auditor for Houston ISD.
You must ONLY flag items that violate the rules provided below. Do NOT make up your own rules.
If an item is not mentioned in any rule, it is allowed — do NOT flag it.

School: ${schoolName}
${storageCategories.length > 0 ? "Storage Categories present: " + storageCategories.join(", ") : ""}

${allRestrictRules}
Current Order Items:
${orderList}

Instructions:
- Check each order item against the rules above.
- ONLY flag items that clearly violate a rule listed above.
- Do NOT flag items just because they seem unusual or are non-food items.
- If no items violate any rules, return an empty array [].

Return ONLY a valid JSON array like this:
[{"index": number, "item": "short item name", "reason": "which rule it violates, 8 words max", "severity": "red or orange"}]

"red" = clear violation of a rule above.
"orange" = borderline/partial match to a rule (e.g. similar item name).`;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 800
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData.error?.message || `API error ${res.status}`;
        return { flags: [], reminders: [], error: "OpenAI API error: " + errMsg };
      }

      const data = await res.json();

      if (data.choices && data.choices[0]) {
        const content = data.choices[0].message.content.trim();
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            flags = JSON.parse(jsonMatch[0]);
          } catch (e) {
            console.error("[SNAP] JSON parse error", content);
            return { flags: [], reminders: missingReminders, error: "Could not parse AI response" };
          }
        }
      }
    } catch (err) {
      console.error("[SNAP]", err);
      return { flags: [], reminders: missingReminders, error: "Network error: " + err.message };
    }
  }

  // Apply highlights on the page — must style individual <td> cells
  // because Telerik RadGrid sets background on cells, not rows
  flags.forEach(f => {
    if (orderItems[f.index]) {
      const row = orderItems[f.index].element;
      const color = f.severity === "red" ? "#ffebee" : "#fff3e0";
      const borderColor = f.severity === "red" ? "#d32f2f" : "#f57c00";

      // Highlight every cell in the row
      const cells = row.querySelectorAll("td");
      cells.forEach(cell => {
        cell.style.setProperty("background-color", color, "important");
      });

      row.style.setProperty("border-left", `5px solid ${borderColor}`, "important");
      row.title = f.reason;
      currentHighlights.push(row);
    }
  });

  return {
    flags: flags,
    reminders: missingReminders,
    schoolName: schoolName,
    itemCount: orderItems.length,
    rulesLoaded: {
      general: generalRules.restrict.length > 0 || generalRules.remind.length > 0 ? schoolLevel : "none",
      school: schoolRules.restrict.length > 0 || schoolRules.remind.length > 0 ? schoolName : "none"
    }
  };
}

function parseCSVRules(csvText) {
  // CSV format: Column A = rule text, Column B = type (restrict or remind)
  // Returns { restrict: [...], remind: [...] }
  const result = { restrict: [], remind: [] };
  const lines = csvText.split("\n").filter(line => line.trim().length > 0);

  lines.forEach((line, idx) => {
    // Skip header row if it looks like one
    if (idx === 0 && (line.toLowerCase().includes("rule") || line.toLowerCase().includes("type"))) {
      return;
    }

    // Parse CSV columns — handle quoted values
    const columns = parseCSVLine(line);
    const ruleText = columns[0] ? columns[0].trim() : "";
    const ruleType = columns[1] ? columns[1].trim().toLowerCase() : "restrict";

    if (ruleText.length > 0) {
      if (ruleType === "remind" || ruleType === "reminder") {
        result.remind.push(ruleText);
      } else {
        result.restrict.push(ruleText);
      }
    }
  });

  return result;
}

function parseCSVLine(line) {
  // Simple CSV parser that handles quoted fields
  const columns = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      columns.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  columns.push(current);
  return columns;
}

function clearHighlights() {
  currentHighlights.forEach(row => {
    const cells = row.querySelectorAll("td");
    cells.forEach(cell => {
      cell.style.removeProperty("background-color");
    });
    row.style.removeProperty("border-left");
    row.title = "";
  });
  currentHighlights = [];
}

function clearSingleHighlight(index) {
  const tableId = "ctl00_UserContentArea_Wizard1_ConfirmOrderLinesRadGrid_ctl00";
  const table = document.getElementById(tableId);
  if (table) {
    const rows = table.querySelectorAll("tr.rgRow, tr.rgAltRow");
    if (rows[index]) {
      const cells = rows[index].querySelectorAll("td");
      cells.forEach(cell => {
        cell.style.removeProperty("background-color");
      });
      rows[index].style.removeProperty("border-left");
      rows[index].title = "";
      // Remove from currentHighlights
      currentHighlights = currentHighlights.filter(r => r !== rows[index]);
    }
  }
}

function highlightSingleRow(index) {
  const tableId = "ctl00_UserContentArea_Wizard1_ConfirmOrderLinesRadGrid_ctl00";
  const table = document.getElementById(tableId);
  if (table) {
    const rows = table.querySelectorAll("tr.rgRow, tr.rgAltRow");
    if (rows[index]) {
      rows[index].scrollIntoView({ behavior: "smooth", block: "center" });
      rows[index].style.setProperty("outline", "3px solid #4a8c3f", "important");
      setTimeout(() => { rows[index].style.removeProperty("outline"); }, 2000);
    }
  }
}
