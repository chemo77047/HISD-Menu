// SNAP Agent - School Nutrition AI Purchasing Agent
// menu-store.js - Supplies the published menu and the school -> serving line map.
//
// Menus come from menus.json, generated from the dietitians' workbook by
// tools/menu_db.py and published to a URL. It is cached in chrome.storage.local
// and falls back to the copy bundled with the extension, so the panel still
// works with no network at all - just with whatever menu shipped in the build.
//
// Menus are keyed by serving line, not by school: menu content in HISD is a
// function of (serving line, date) only, and the same "K-8 Lunch" menu is served
// by hundreds of schools.

const MENU_URL_KEY = "snap.menuUrl";
const MENU_CACHE_KEY = "snap.menuCache";
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

export const DEFAULT_MENU_URL =
  "https://raw.githubusercontent.com/chemo77047/HISD-Menu/main/data/menus.json";

export async function getMenuUrl() {
  const stored = await chrome.storage.local.get(MENU_URL_KEY);
  return stored[MENU_URL_KEY] || DEFAULT_MENU_URL;
}

// https only: the menu is rendered as the authority on what a school is served,
// so it may not arrive over a channel anything on the network can rewrite.
export async function setMenuUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("the menu URL must be https");
  await chrome.storage.local.set({ [MENU_URL_KEY]: parsed.toString() });
}

async function readBundledMenus() {
  const response = await fetch(chrome.runtime.getURL("data/menus.json"));
  if (!response.ok) throw new Error(`bundled menus.json HTTP ${response.status}`);
  return response.json();
}

function isUsable(payload) {
  return payload && typeof payload === "object" && payload.lines && payload.firstDate;
}

// Returns { menus, source, fetchedAt, error }. `error` is advisory: a stale or
// bundled menu is still shown, with the panel saying where it came from, because
// an out-of-date menu is more useful than an empty screen.
export async function getMenus({ forceRefresh = false } = {}) {
  const cached = (await chrome.storage.local.get(MENU_CACHE_KEY))[MENU_CACHE_KEY];
  const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  const url = await getMenuUrl();
  const cacheHit = cached && cached.source === url && isUsable(cached.menus);

  if (!forceRefresh && cacheHit && age < REFRESH_AFTER_MS) {
    return { menus: cached.menus, source: cached.source, fetchedAt: cached.fetchedAt };
  }

  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const menus = await response.json();
    if (!isUsable(menus)) throw new Error("menu file is missing its 'lines' data");

    const entry = { menus, source: url, fetchedAt: new Date().toISOString() };
    await chrome.storage.local.set({ [MENU_CACHE_KEY]: entry });
    return entry;
  } catch (error) {
    const reason = String(error.message || error);
    if (cacheHit) {
      return { ...cached, error: reason };
    }
    return {
      menus: await readBundledMenus(),
      source: "bundled with the extension",
      fetchedAt: null,
      error: reason,
    };
  }
}

// ------------------------------------------------------------------- schools

let schoolIndexPromise = null;

function loadSchoolIndex() {
  if (!schoolIndexPromise) {
    schoolIndexPromise = fetch(chrome.runtime.getURL("schools.json")).then((r) => r.json());
  }
  return schoolIndexPromise;
}

// PrimeroEdge and SchoolCafe spell the same school differently ("Northside HS"
// vs "Northside High School"), so both sides are reduced to the same form.
export function normalizeSchoolName(name) {
  let text = (name || "").toLowerCase().replace(/&/g, " and ");
  text = text.replace(/[^a-z0-9]+/g, " ").trim();
  text = text.replace(/\bh s\b/g, "hs");
  text = text.replace(/\b(senior )?high school\b|\bhigh\b/g, "hs");
  text = text.replace(/\b(elementary school|elementary|elem)\b/g, "es");
  text = text.replace(/\b(middle school|middle|jr high|junior high)\b/g, "ms");
  text = text.replace(/\b(education center|ed ctr|ed center|educ ctr)\b/g, "ec");
  text = text.replace(/\bschool\b/g, "");
  return text.replace(/\s+/g, " ").trim();
}

const ALIAS_KEY = "snap.schoolAliases";

export async function saveSchoolAlias(rawName, schoolKey) {
  const aliases = (await chrome.storage.local.get(ALIAS_KEY))[ALIAS_KEY] || {};
  aliases[normalizeSchoolName(rawName)] = schoolKey;
  await chrome.storage.local.set({ [ALIAS_KEY]: aliases });
}

export async function resolveSchool(rawName) {
  const index = await loadSchoolIndex();
  const key = normalizeSchoolName(rawName);

  const aliases = (await chrome.storage.local.get(ALIAS_KEY))[ALIAS_KEY] || {};
  const aliased = aliases[key];
  if (aliased && index.byKey[aliased]) {
    return { ...index.byKey[aliased], key: aliased, matchedBy: "saved choice" };
  }
  if (index.byKey[key]) {
    return { ...index.byKey[key], key, matchedBy: "name" };
  }
  return { unresolved: true, rawName, suggestions: suggestSchools(key, index) };
}

// Ranked alternatives for the user to pick from. A close-but-wrong guess is
// never accepted silently, because showing the wrong school's menu is worse
// than showing none.
function suggestSchools(key, index) {
  const wanted = new Set(key.split(" ").filter(Boolean));
  const scored = [];
  for (const [candidateKey, school] of Object.entries(index.byKey)) {
    const tokens = candidateKey.split(" ").filter(Boolean);
    if (tokens.length === 0) continue;
    const hits = tokens.filter((token) => wanted.has(token)).length;
    if (hits === 0) continue;
    scored.push({
      key: candidateKey,
      name: school.name,
      score: hits / Math.max(wanted.size, tokens.length),
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 8);
}

// The serving lines a school uses, restricted to those the workbook publishes a
// menu for. Schools also carry summer "SSO Cold" lines that have no workbook
// sheet; those simply never appear.
export function linesForSchool(school, menus) {
  const published = new Set(Object.keys(menus.lines || {}));
  const lines = [...(school.breakfast || []), ...(school.lunch || [])];
  return [...new Set(lines)].filter((line) => published.has(line));
}

// Serving line + date -> items, flattened across every line the school uses.
export function menuForDates(menus, lines, dates) {
  const byDate = {};
  for (const date of dates) byDate[date] = [];

  for (const line of lines) {
    const days = menus.lines[line] || {};
    const meal = (menus.meals && menus.meals[line]) || "";
    for (const date of dates) {
      for (const item of days[date] || []) {
        byDate[date].push({ ...item, servingLine: line, meal });
      }
    }
  }
  return byDate;
}
