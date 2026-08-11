// SNAP Agent - School Nutrition AI Purchasing Agent
// menu.js - The menu window: what is served on the delivery date and the next
// five school days, and what the order looks to be missing.
//
// It runs in its own window so it can sit beside PrimeroEdge while the order is
// being keyed, which is the whole point: nobody should have to leave the order
// screen to look a menu up.

const CONTEXT_KEY = "snap.orderContext";

const MEAL_ORDER = ["Breakfast", "Lunch", "Snack", "Dinner"];
const CATEGORY_ORDER = [
  "Entrees", "Meat/Meat Alternates", "Grain/ M/MA", "Grains", "Salad Base", "LTO",
  "Vegetable Sides", "Fruit Sides", "Fruit", "Grain/Other Side",
  "Condiments/ Side", "Condiments",
];

const el = (id) => document.getElementById(id);

function categoryRank(category) {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function mealRank(meal) {
  const index = MEAL_ORDER.indexOf(meal);
  return index === -1 ? MEAL_ORDER.length : index;
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function shortDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${month}/${day}/${year}`;
}

async function loadContext() {
  const stored = await chrome.storage.session.get(CONTEXT_KEY);
  return stored[CONTEXT_KEY] || null;
}

// Re-reads the order page so the window can be left open while the order changes.
async function refreshContext(tabId) {
  if (!tabId) return null;
  try {
    const context = await chrome.tabs.sendMessage(tabId, { action: "getOrderContext" });
    if (context) {
      await chrome.storage.session.set({ [CONTEXT_KEY]: { ...context, tabId } });
      return { ...context, tabId };
    }
  } catch {
    // The tab was closed or navigated away; the stored context still stands.
  }
  return null;
}

async function render({ forceRefresh = false, rereadPage = false } = {}) {
  let context = await loadContext();
  if (!context) {
    showError("Open a PrimeroEdge order, then click Show Menu in the SNAP Agent popup.");
    return;
  }
  if (rereadPage) {
    context = (await refreshContext(context.tabId)) || context;
  }

  const report = await chrome.runtime.sendMessage({
    action: "buildMenuReport",
    context,
    options: { forceRefresh },
  });

  if (report.needsSchoolChoice) {
    renderChooser(report, context);
    return;
  }
  if (report.error && !report.days) {
    showError(report.error);
    renderDataSource(report.dataSource);
    return;
  }

  el("chooser").hidden = true;
  el("school").textContent = report.school;

  const orderedOn = report.orderDate ? `, keyed ${shortDate(report.orderDate)}` : "";
  el("subtitle").textContent =
    `Delivery ${shortDate(report.deliveryDate)}${orderedOn} \u2022 ` +
    `${report.orderItemCount} lines on the order \u2022 ${report.servingLines.join(", ")}`;

  renderNotice(report);
  renderMissing(report);
  renderDays(report);
  renderDataSource(report.dataSource);
}

function showError(text) {
  el("school").textContent = "SNAP Agent";
  el("subtitle").textContent = "";
  const notice = el("notice");
  notice.hidden = false;
  notice.className = "notice error";
  notice.textContent = text;
  el("days").innerHTML = "";
  el("missingSection").hidden = true;
}

function renderNotice(report) {
  const notice = el("notice");
  const unpublished = report.days.filter((day) => !day.published);
  const messages = [];

  if (unpublished.length === report.days.length) {
    messages.push(
      `No menu is published for any of these days. The menu file covers ` +
      `${shortDate(report.coverage.firstDate)} to ${shortDate(report.coverage.lastDate)}.`);
  } else if (unpublished.length > 0) {
    messages.push(
      `No menu published yet for ${unpublished.map((day) => day.label).join(", ")}. ` +
      `The menu file ends ${shortDate(report.coverage.lastDate)}.`);
  }
  if (report.matchedBy === "saved choice") {
    messages.push("School matched from a choice saved earlier.");
  }

  notice.hidden = messages.length === 0;
  notice.className = "notice";
  notice.textContent = messages.join(" ");
}

function renderMissing(report) {
  const container = el("missing");
  container.innerHTML = "";

  if (!report.missing || report.missing.length === 0) {
    el("missingSection").hidden = false;
    container.innerHTML =
      '<p class="muted">Every entree and side on these days matches something on the order.</p>';
    return;
  }
  el("missingSection").hidden = false;

  for (const entry of report.missing) {
    const row = document.createElement("div");
    row.className = "missing-row";

    const name = document.createElement("div");
    if (entry.kind === "component") {
      name.innerHTML =
        `<span class="missing-part">${escapeHtml(entry.part)}</span> for ` +
        `<span class="missing-name">${escapeHtml(entry.name)}</span>`;
    } else if (entry.part) {
      name.innerHTML =
        `<span class="missing-part">${escapeHtml(entry.part)}</span> ` +
        `<span class="muted">(part of ${escapeHtml(entry.name)})</span>`;
    } else {
      name.innerHTML = `<span class="missing-name">${escapeHtml(entry.name)}</span>`;
    }

    const when = document.createElement("div");
    when.className = "missing-when";
    when.textContent = `${entry.category} \u2022 served ${entry.dates.map(shortDate).join(", ")}`;

    row.append(name, when);
    container.appendChild(row);
  }
}

function renderDays(report) {
  const container = el("days");
  container.innerHTML = "";

  // Anything warned about is marked in the day list too, so a buyer reading down
  // Wednesday can see at a glance which of Wednesday's food is not on the order.
  const flaggedNames = new Set((report.missing || []).map((entry) => entry.name));

  for (const day of report.days) {
    const section = document.createElement("section");
    section.className = "day" + (day.date === report.deliveryDate ? " is-delivery" : "");

    const head = document.createElement("div");
    head.className = "day-head";
    head.innerHTML =
      `${escapeHtml(day.weekday)}<span class="day-date">${shortDate(day.date)}` +
      `${day.date === report.deliveryDate ? " \u2014 delivery day" : ""}</span>`;
    section.appendChild(head);

    const body = document.createElement("div");
    body.className = "day-body";

    if (!day.published) {
      body.innerHTML = '<p class="muted">No menu published for this day.</p>';
    } else {
      const byMeal = [...groupBy(day.items, (item) => item.meal || "Menu")]
        .sort((a, b) => mealRank(a[0]) - mealRank(b[0]));

      for (const [meal, mealItems] of byMeal) {
        const byCategory = [...groupBy(mealItems, (item) => item.category)]
          .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]));

        for (const [category, items] of byCategory) {
          const group = document.createElement("div");
          group.className = "group";

          const title = document.createElement("div");
          title.className = "group-title";
          title.textContent = `${meal} \u2014 ${category}`;
          group.appendChild(title);

          const seen = new Set();
          for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
            if (seen.has(item.name)) continue;
            seen.add(item.name);

            const row = document.createElement("div");
            const notOrdered = item.flaggable && flaggedNames.has(item.name);
            row.className = "item" + (notOrdered ? " not-ordered" : "");
            row.innerHTML = escapeHtml(item.name) +
              (notOrdered ? '<span class="tag">not on this order</span>' : "");
            group.appendChild(row);
          }
          body.appendChild(group);
        }
      }
    }
    section.appendChild(body);
    container.appendChild(section);
  }
}

function renderChooser(report, context) {
  el("school").textContent = report.rawName;
  el("subtitle").textContent = "";
  el("missingSection").hidden = true;
  el("days").innerHTML = "";
  el("chooser").hidden = false;

  const options = el("chooserOptions");
  options.innerHTML = "";
  for (const suggestion of report.suggestions || []) {
    const button = document.createElement("button");
    button.className = "btn secondary";
    button.textContent = suggestion.name;
    button.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        action: "chooseSchool",
        rawName: context.schoolName,
        schoolKey: suggestion.key,
      });
      render();
    });
    options.appendChild(button);
  }
  if (!report.suggestions || report.suggestions.length === 0) {
    options.innerHTML = '<p class="muted">No similar school name found in the school list.</p>';
  }
}

function renderDataSource(dataSource) {
  if (!dataSource) return;
  const when = dataSource.fetchedAt
    ? new Date(dataSource.fetchedAt).toLocaleString()
    : "not downloaded";
  const problem = dataSource.error
    ? ` \u2014 could not reach the published menu (${dataSource.error}), showing the last copy.`
    : "";
  el("dataSource").textContent = `Menu data: ${dataSource.source} (${when})${problem}`;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

el("refreshBtn").addEventListener("click", () =>
  render({ forceRefresh: true, rereadPage: true }));

render();
