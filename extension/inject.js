// SNAP Agent - School Nutrition AI Purchasing Agent
// inject.js - Puts content.js into the order tab, only when it is needed.
//
// It used to be declared as a content script on every URL, which meant every tab
// of every site paid for it. It is only ever wanted in the tab holding an order,
// at the moment a button is pressed, so it is injected then instead.

const READ_TIMEOUT_MS = 5000;

async function alreadyThere(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Boolean(window.__snapAgentLoaded),
  });
  return Boolean(result);
}

export async function ensureContentScript(tabId) {
  if (!tabId) throw new Error("no tab to read");
  if (await alreadyThere(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

/**
 * Reads the order off a tab, injecting the reader first if it is not there yet.
 *
 * A page mid-postback can leave the reply outstanding indefinitely, so the wait
 * is bounded: better to say the page could not be read than to sit on a button
 * that looks stuck.
 */
export async function readOrderContext(tabId) {
  await ensureContentScript(tabId);

  const reply = chrome.tabs.sendMessage(tabId, { action: "getOrderContext" });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("the page did not answer in time")), READ_TIMEOUT_MS);
  });
  return Promise.race([reply, timeout]);
}
