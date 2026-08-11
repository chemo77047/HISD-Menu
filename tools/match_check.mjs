// Dry-run of the missing-item check against a real order, outside the browser.
//
//   node tools/match_check.mjs [menus.json] [YYYY-MM-DD]
//
// Prints every menu item for the coverage window with its best-matching order
// line and score, so the threshold in extension/menu-match.js can be re-tuned
// against real data instead of guesses. The order below is a real Northside HS
// order captured from PrimeroEdge.

import { readFileSync } from "node:fs";
import { coverageWindow, weekdayName } from "../extension/dates.js";
import { bestOrderMatch, findMissingItems, isFlaggable, splitOnServedWith, tokenize }
  from "../extension/menu-match.js";

const ORDER = [
  "BREAD, BUN ROUND 3.75\" SLICED FZ 120/2OZ",
  "BREADSTICK, CHEESY GRLC 120/1.07 OZ CS",
  "BRK, BEEF SSG SANDWICH IW 100/3.1 CS",
  "BRK, BF SSG & CHZ BAGEL IW 72/2.65 CS",
  "BRK, FRENCH TOAST STICKS IW 100 CT CS",
  "CHICKEN, NUGGET WM 4/5 LB CS",
  "CHIPS, LAYS ORIGINAL BAKED 60/.875 OZ CS",
  "DS, TRAY 5 COMPARTMENT 500 CT CS",
  "FRUIT, PEACHES DICED CANNED 6/#10 CS",
  "FRUIT, RAISINS 200/1.33 OZ CS",
  "JUICE, 100% FRUIT PUNCH ASPTIC 96/4OZ CS",
  "MUFFIN, CORN IW 72/2 OZ CS",
  "PIZZA, CHEESE THIN CRUST 8-CUT 72SV/CS",
  "PUDDING, CHOCOLATE POUCH 6/112 OZ CS",
  "SEASONING, FAJITA BLEND 20 OZ CTN",
  "VEG, POTATO SWEET FRIES 6/2.5 LB CS",
].map((item, index) => ({ index, item }));

// Northside HS, per the SchoolCafe school map.
const LINES = ["Breakfast Traditional OVS K-12", "HS Homestyle Lunch", "HS Snack Favorites",
  "HS Deli and Salad"];

const menusPath = process.argv[2] || "data/menus.json";
const menus = JSON.parse(readFileSync(menusPath, "utf8"));
const delivery = process.argv[3] || menus.firstDate;
const dates = coverageWindow(delivery);

const byDate = {};
for (const date of dates) {
  byDate[date] = [];
  for (const line of LINES) {
    for (const item of (menus.lines[line] || {})[date] || []) {
      byDate[date].push({ ...item, servingLine: line, meal: menus.meals[line] });
    }
  }
}

const orderTokens = ORDER.map((entry) => ({ item: entry.item, tokens: tokenize(entry.item) }));

console.log(`delivery ${delivery} -> ${dates.map((d) => `${weekdayName(d)} ${d}`).join(", ")}\n`);

for (const date of dates) {
  console.log(`--- ${weekdayName(date)} ${date}  (${byDate[date].length} items)`);
  for (const item of byDate[date]) {
    if (!isFlaggable(item.category)) continue;
    for (const part of splitOnServedWith(item.name)) {
      const best = bestOrderMatch(part, orderTokens);
      console.log(`  ${best.score.toFixed(2)}  ${part.padEnd(56)} <- ${best.orderLine || "-"}`);
    }
  }
}

const components = JSON.parse(readFileSync("extension/components.json", "utf8"));
const missing = findMissingItems(byDate, ORDER, components);
console.log(`\n${missing.length} warnings:`);
for (const entry of missing) {
  const label = entry.kind === "component" ? `${entry.part} for ${entry.name}`
    : entry.part ? `${entry.part} (part of ${entry.name})` : entry.name;
  console.log(`  [${entry.category}] ${label}  -- ${entry.dates.join(", ")}`);
}
