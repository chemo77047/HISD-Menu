// Dry-run of the AI second look with a stubbed OpenAI reply, so the clearing,
// caching and failure paths can be exercised without a key or a network call.
//
//   node tools/ai_review_check.mjs
//
// Temporarily set API_KEY in extension/config.js to "sk-test" first, otherwise
// the review is skipped by design and there is nothing to see.

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (patch) => Object.assign(store, patch),
    },
  },
};

let calls = 0;
let reply = { supplied: [{ id: 0, order: 3 }] };
globalThis.fetch = async () => {
  calls += 1;
  if (reply instanceof Error) throw reply;
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
  };
};

const { reviewMissing } = await import("../extension/menu-ai.js");

const ORDER = [
  "JUICE, 100% APPLE ASEPTIC 96/4OZ CS",
  "VEG, BROCCOLI FLORETS FZ 12/2 LB CS",
  "SANDWICH, SOYBUTTER JELLY GRAPE IW 40CT",
  "CHICKEN, NUGGET WM 4/5 LB CS",
].map((item, index) => ({ index, item }));

const MISSING = [
  { kind: "menu-item", name: "Broccoli, Frozen, Butter Buds, Fajita", part: null,
    category: "Vegetable Sides", dates: ["2026-08-12"] },
  { kind: "menu-item", name: "Pears, Diced (Drained)", part: null,
    category: "Fruit Sides", dates: ["2026-08-12"] },
  { kind: "component", name: "Beef (C), Burger", part: "burger buns",
    category: "Entrees", dates: ["2026-08-11"] },
];

const first = await reviewMissing(MISSING, ORDER);
console.log(`cleared ${first.review.cleared} of ${first.review.checked}, calls ${calls}`);
console.log(`remaining: ${first.missing.map((entry) => entry.part || entry.name).join(" | ")}`);

const second = await reviewMissing(MISSING, ORDER);
console.log(`repeat: cached ${second.review.cached}, calls still ${calls}`);

reply = new Error("network down");
const third = await reviewMissing(MISSING, [{ index: 0, item: "SOMETHING ELSE 1 CS" }]);
console.log(`on failure: kept ${third.missing.length} of ${MISSING.length}, `
  + `error ${JSON.stringify(third.review.error)}`);
