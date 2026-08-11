// SNAP Agent - School Nutrition AI Purchasing Agent
// menu-match.js - Works out which menu items have no matching line on the order.
//
// Menu names come from the dietitians' workbook ("Pizza (C), Cheese, 8 Cut");
// order lines are vendor catalog names ("PIZZA, CHEESE THIN CRUST 8-CUT
// 72SV/CS"). Both use the same "CATEGORY, descriptor" convention, so comparing
// their significant words is reliable enough to act on without asking a model.
//
// Deliberately rule-based: the same order always produces the same warnings, a
// menu item can never be invented, and it costs nothing to run. The failure mode
// that matters is a false alarm about something the buyer did order, so anything
// short of a confident miss is left alone.

// Fraction of a menu item's distinctive words an order line must contain.
// Tuned against a real order: 0.67 accepts "Muffin, Corn" for "MUFFIN, CORN IW
// 72/2 OZ CS" while rejecting "Pears, Diced" for "FRUIT, PEACHES DICED CANNED",
// which shares only "diced".
const MATCH_THRESHOLD = 0.67;

// Pack sizes, storage codes and vendor shorthand carry no dish information.
const NOISE = new Set([
  "cs", "ct", "cse", "case", "cases", "ea", "each", "pk", "pkg", "bx", "box", "ctn",
  "oz", "ozs", "lb", "lbs", "gal", "qt", "pt", "ml", "kg", "dz", "doz", "sv", "svg",
  "iw", "fz", "frz", "frozen", "rfg", "ref", "refrigerated", "cnd", "canned", "cp",
  "wg", "wgr", "ckd", "cooked", "new", "lto", "prek", "hs", "ms",
  "serv", "serving", "servings", "portion", "cut", "sliced", "slice", "drained",
  "with", "and", "or", "the", "of", "in", "on", "individual", "mini",
  "plain", "asptic", "aseptic", "pouch", "bag", "bulk", "wrapped", "ds",
]);

// Vendor abbreviations, and plural forms the stemmer alone would not unify.
const SYNONYMS = new Map([
  ["chz", "cheese"], ["chkn", "chicken"], ["bf", "beef"], ["brk", "breakfast"],
  ["ssg", "sausage"], ["veg", "vegetable"], ["grlc", "garlic"], ["wm", "wholemuscle"],
  ["choc", "chocolate"], ["sndwch", "sandwich"], ["strwbry", "strawberry"],
  ["fries", "fry"], ["potatoes", "potato"], ["tomatoes", "tomato"],
  ["nuggets", "nugget"], ["tenders", "tender"], ["sandwiches", "sandwich"],
  ["buns", "bun"], ["rolls", "roll"], ["chips", "chip"],
]);

function stem(word) {
  if (SYNONYMS.has(word)) return SYNONYMS.get(word);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  const cleaned = (text || "")
    .toLowerCase()
    .replace(/\b\d{2}-\d{2}\b/g, " ")                       // school-year suffix
    .replace(/\d+(\.\d+)?\s*(%|oz|lb|ct|ml|in|")?/g, " ")   // pack sizes
    .replace(/[^a-z\s]/g, " ");

  const tokens = [];
  for (const word of cleaned.split(/\s+/)) {
    if (word.length < 2 || NOISE.has(word)) continue;
    const stemmed = stem(word);
    if (!NOISE.has(stemmed)) tokens.push(stemmed);
  }
  return [...new Set(tokens)];
}

export function scoreMatch(menuTokens, orderTokens) {
  if (menuTokens.length === 0) return 0;
  const available = new Set(orderTokens);
  const hits = menuTokens.filter((token) => available.has(token)).length;
  return hits / menuTokens.length;
}

// Condiments are shown in the panel but never warned about; milk is dropped from
// the menu file upstream because it is delivered on a separate dairy order.
export function isFlaggable(category) {
  const lowered = (category || "").toLowerCase();
  return !lowered.includes("condiment") && !lowered.includes("milk");
}

// Entrees whose menu name already lists what comes with them - "Beef, Steak
// Fingers w/Roll", "Macaroni and Cheese (C) w/Cornbread Poppers (C)" - are split
// so the roll and the cornbread are checked in their own right instead of being
// buried in one long string that matches nothing.
export function splitOnServedWith(name) {
  const parts = (name || "").split(/\s*\bw\/\s*|\s+with\s+/i);
  return parts.map((part) => part.trim()).filter((part) => part.length > 2);
}

// Both the workbook and the vendor catalog name things class-first - "Pizza (C),
// Cheese, 8 Cut" against "PIZZA, CHEESE THIN CRUST" - so the leading word is the
// food itself and everything after it is description. Requiring that word to be
// present stops shared adjectives from carrying a match on their own: without it
// "Burrito, Beef & Cheese" scores 0.67 against a beef sausage and cheese bagel.
export function bestOrderMatch(text, orderTokenized) {
  const tokens = tokenize(text);
  const head = tokens[0];
  let best = { score: 0, orderLine: null };
  for (const candidate of orderTokenized) {
    if (head && !candidate.tokens.includes(head)) continue;
    const score = scoreMatch(tokens, candidate.tokens);
    if (score > best.score) best = { score, orderLine: candidate.item };
  }
  return best;
}

/**
 * Compares the published menu for a set of dates against the order lines.
 *
 * menuByDate  { "2026-09-09": [{ name, category, recipe, servingLine }] }
 * orderItems  [{ index, item }]
 * components  parsed components.json, for entrees whose extras are implicit
 *
 * Returns one entry per menu item that looks absent, each carrying every date it
 * is served on so an item on the menu three times is a single warning.
 */
export function findMissingItems(menuByDate, orderItems, components = { rules: [] }) {
  const orderTokenized = orderItems.map((entry) => ({
    item: entry.item,
    tokens: tokenize(entry.item),
  }));

  const missing = new Map();

  const record = (key, detail, date) => {
    const existing = missing.get(key);
    if (existing) {
      if (!existing.dates.includes(date)) existing.dates.push(date);
      return;
    }
    missing.set(key, { ...detail, dates: [date] });
  };

  for (const [date, items] of Object.entries(menuByDate)) {
    for (const item of items) {
      if (!isFlaggable(item.category)) continue;

      // Each "served with" part is checked separately; a single-part name just
      // yields one part, so entrees and sides go down the same path.
      const parts = splitOnServedWith(item.name);
      for (const part of parts) {
        const best = bestOrderMatch(part, orderTokenized);
        if (best.score >= MATCH_THRESHOLD) continue;
        record(`item:${item.name}:${part}`, {
          kind: "menu-item",
          name: item.name,
          part: parts.length > 1 ? part : null,
          category: item.category,
          recipe: item.recipe,
          servingLine: item.servingLine,
          meal: item.meal,
        }, date);
      }

      // Implicit extras: nothing on the menu says a burger needs buns.
      for (const missingComponent of missingComponents(item, orderTokenized, components)) {
        record(`component:${item.name}:${missingComponent.label}`, {
          kind: "component",
          name: item.name,
          part: missingComponent.label,
          category: item.category,
          recipe: item.recipe,
          servingLine: item.servingLine,
          meal: item.meal,
        }, date);
      }
    }
  }

  return [...missing.values()]
    .map((entry) => ({ ...entry, dates: entry.dates.sort() }))
    .sort((a, b) => a.dates[0].localeCompare(b.dates[0]) || a.name.localeCompare(b.name));
}

function missingComponents(item, orderTokenized, components) {
  const lowered = (item.name || "").toLowerCase();
  const result = [];

  for (const rule of components.rules || []) {
    if (!(rule.when || []).some((trigger) => lowered.includes(trigger))) continue;
    for (const need of rule.needs || []) {
      const satisfied = orderTokenized.some((candidate) =>
        (need.any || []).some((word) => candidate.tokens.includes(stem(word))));
      if (!satisfied) result.push(need);
    }
  }
  return result;
}
