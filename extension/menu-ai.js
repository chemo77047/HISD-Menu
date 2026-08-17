// SNAP Agent - School Nutrition AI Purchasing Agent
// menu-ai.js - Second look at the items the word matching thinks are missing.
//
// The rule-based pass in menu-match.js is deliberately literal, so wording the
// vendor and the dietitians disagree about ("Sandwich, Soy Butter and Jelly"
// against "SANDWICH, SOYBUTTER JELLY GRAPE", "Broccoli, Butter Buds, Fajita"
// against "VEG, BROCCOLI FLORETS") reads as absent when it was ordered. A model
// is good at exactly that judgement, so it reviews the shortlist afterwards.
//
// Two rules keep this safe: it only ever *clears* an item, never adds one, and a
// failure of any kind leaves the rule-based answer untouched. Worst case the
// window is as it was before this file existed.

import { API_KEY, KEY_IS_SET } from "./config.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const CACHE_KEY = "snap.aiReviewCache";
const CACHE_LIMIT = 40;

const INSTRUCTIONS = [
  "You check school cafeteria orders for Houston ISD.",
  "MENU items are written by dietitians. ORDER lines are vendor catalog names for",
  "what the school actually bought, and are written differently: abbreviated,",
  "run together, with pack sizes and brand words.",
  "For each MENU item, decide whether any ORDER line supplies it.",
  "Say it is supplied when the same food is there under different wording, or when",
  "an order line is the bulk or packaged form of it.",
  "Say it is not supplied when the food differs in kind or in flavor - apple juice",
  "is not fruit punch, peaches are not pears, beef is not turkey - or when nothing",
  "on the order plausibly covers it. Prepared dishes may appear as their main",
  "ingredient; seasonings and cooking method need not appear at all.",
  "Answer as JSON: {\"supplied\":[{\"id\":<menu id>,\"order\":<order line number>}]}.",
  "Include only the ids you are confident about. Omit everything else.",
].join(" ");

/**
 * Removes from `missing` the entries a model recognises on the order.
 *
 * missing     findMissingItems() output
 * orderItems  [{ index, item }] straight off the order page
 *
 * Returns { missing, review: { checked, cleared, cached, error } } - `review` is
 * for the window's footer, so a quiet failure is still visible if looked for.
 */
export async function reviewMissing(missing, orderItems) {
  if (!KEY_IS_SET || missing.length === 0 || orderItems.length === 0) {
    return { missing, review: { checked: 0, cleared: 0, skipped: !KEY_IS_SET } };
  }

  // Components ("buns for Beef, Burger") are asserted by our own rules rather
  // than read off the menu, so they are not the model's to second-guess.
  const candidates = missing.filter((entry) => entry.kind === "menu-item");
  if (candidates.length === 0) return { missing, review: { checked: 0, cleared: 0 } };

  const question = buildQuestion(candidates, orderItems);
  const signature = await hash(question);

  try {
    const cached = await readCache(signature);
    const supplied = cached || await ask(question);
    if (!cached) await writeCache(signature, supplied);

    const cleared = new Set(supplied.map((id) => candidates[id] && keyOf(candidates[id]))
      .filter(Boolean));

    return {
      missing: missing.filter((entry) => !cleared.has(keyOf(entry))),
      review: {
        checked: candidates.length,
        cleared: cleared.size,
        cached: Boolean(cached),
      },
    };
  } catch (error) {
    return {
      missing,
      review: { checked: candidates.length, cleared: 0, error: String(error.message || error) },
    };
  }
}

function keyOf(entry) {
  return `${entry.kind}:${entry.name}:${entry.part || ""}`;
}

function buildQuestion(candidates, orderItems) {
  const order = orderItems.map((entry, index) => `${index}. ${entry.item}`).join("\n");
  const menu = candidates
    .map((entry, index) => `${index}. ${entry.part || entry.name} [${entry.category}]`)
    .join("\n");
  return `ORDER LINES:\n${order}\n\nMENU ITEMS:\n${menu}`;
}

async function ask(question) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: question },
      ],
    }),
  });

  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  const payload = await response.json();
  const parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");

  return (parsed.supplied || [])
    .map((entry) => Number(entry && entry.id))
    .filter((id) => Number.isInteger(id) && id >= 0);
}

// Reopening the window for the same order should not pay for the same question
// twice; the signature covers the order lines and the shortlist, so any change
// to either asks afresh.
async function hash(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readCache(signature) {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const entry = (stored[CACHE_KEY] || {})[signature];
  return entry ? entry.supplied : null;
}

async function writeCache(signature, supplied) {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cache = stored[CACHE_KEY] || {};
  cache[signature] = { supplied, at: Date.now() };

  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    keys.sort((a, b) => cache[a].at - cache[b].at)
      .slice(0, keys.length - CACHE_LIMIT)
      .forEach((key) => delete cache[key]);
  }
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}
