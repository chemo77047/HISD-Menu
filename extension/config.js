// SNAP Agent - School Nutrition AI Purchasing Agent
// config.js - The two settings that are yours rather than the code's.
//
// Paste your OpenAI key between the quotes. Anyone the extension folder is given
// to can read it, so hand the folder out no more widely than you would the key.
// Everything works without it except Scan Order and the second look at possible
// missing items; the menu itself never needs it.
export const API_KEY = "YOUR_OPENAI_API_KEY_HERE";

// The sheet holding your rules and restrictions, read by Scan Order.
export const SPREADSHEET_ID = "1NOtQu0_rErgdA_5IlFMaA59Po6mVhRLU-L7Lhup0nZA";

export const KEY_IS_SET = /^sk-\S+/.test(API_KEY);
