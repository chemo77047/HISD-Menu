// SNAP Agent - School Nutrition AI Purchasing Agent
// background.js - Service worker: owns the menu data and the missing-item check.
//
// This work lives here rather than in the content script so the fetch of the
// published menu file is not subject to the PrimeroEdge page's CORS policy, and
// so one cached copy of the menu serves every tab.

import { coverageWindow, formatShort, weekdayName } from "./dates.js";
import {
  getMenuUrl,
  getMenus,
  linesForSchool,
  menuForDates,
  resolveSchool,
  saveSchoolAlias,
  setMenuUrl,
} from "./menu-store.js";
import { findMissingItems, isFlaggable } from "./menu-match.js";

chrome.commands.onCommand.addListener((command) => {
  if (command === "scan-order") chrome.action.openPopup();
});

let componentsPromise = null;

function loadComponents() {
  if (!componentsPromise) {
    componentsPromise = fetch(chrome.runtime.getURL("components.json"))
      .then((response) => response.json())
      .catch(() => ({ rules: [] }));
  }
  return componentsPromise;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "buildMenuReport") {
    buildMenuReport(message.context, message.options || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ error: String(error.message || error) }));
    return true;
  }
  if (message.action === "chooseSchool") {
    saveSchoolAlias(message.rawName, message.schoolKey)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: String(error.message || error) }));
    return true;
  }
  if (message.action === "getMenuUrl") {
    getMenuUrl().then((url) => sendResponse({ url }));
    return true;
  }
  if (message.action === "setMenuUrl") {
    setMenuUrl(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: String(error.message || error) }));
    return true;
  }
  return false;
});

/**
 * Everything the menu window needs for one order: the days it covers, what is
 * served on each of them, and what looks absent from the order.
 *
 * context  { schoolName, deliveryDate, orderDate, items } from the order page
 */
async function buildMenuReport(context, options) {
  if (!context || !context.schoolName) {
    return { error: "No school name found on the page. Open a PrimeroEdge order first." };
  }
  if (!context.deliveryDate) {
    return { error: "No delivery date found on the page. Open the order's confirmation step." };
  }

  const { menus, source, fetchedAt, error: menuError } = await getMenus({
    forceRefresh: Boolean(options.forceRefresh),
  });

  const school = await resolveSchool(context.schoolName);
  if (school.unresolved) {
    return {
      needsSchoolChoice: true,
      rawName: context.schoolName,
      suggestions: school.suggestions,
      dataSource: { source, fetchedAt, error: menuError },
    };
  }

  const dates = coverageWindow(context.deliveryDate);
  const lines = linesForSchool(school, menus);

  if (lines.length === 0) {
    return {
      school: school.name,
      dates: [],
      error: `${school.name} has no serving line with a published menu.`,
      dataSource: { source, fetchedAt, error: menuError },
    };
  }

  const byDate = menuForDates(menus, lines, dates);
  const days = dates.map((date) => ({
    date,
    weekday: weekdayName(date),
    label: `${weekdayName(date)} ${formatShort(date)}`,
    // Outside the published month there is simply nothing to show, which the
    // window reports rather than passing off as a day with no food on it.
    published: (byDate[date] || []).length > 0,
    items: (byDate[date] || []).map((item) => ({ ...item, flaggable: isFlaggable(item.category) })),
  }));

  const missing = findMissingItems(byDate, context.items || [], await loadComponents());

  return {
    school: school.name,
    matchedBy: school.matchedBy,
    servingLines: lines,
    deliveryDate: context.deliveryDate,
    orderDate: context.orderDate,
    orderItemCount: (context.items || []).length,
    days,
    missing,
    coverage: { firstDate: menus.firstDate, lastDate: menus.lastDate },
    dataSource: { source, fetchedAt, error: menuError },
  };
}
