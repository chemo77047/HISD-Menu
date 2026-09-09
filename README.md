# HISD-Menu

Menu data and Chrome extension for **SNAP Agent**, used by Houston ISD Nutrition
Services while placing food orders in PrimeroEdge.

While an order is open, SNAP Agent shows what is on the menu for the delivery
date and the next five school days, and points out entrees and sides on those
days that nothing on the order appears to cover. Nobody has to leave the order
screen to look a menu up.

```
monthly workbook (kept off GitHub - it has costs in it)
        |  SNAP Menu Builder, then upload menus.json
        v
data/menus.json  --published--> raw.githubusercontent.com
        |                              |
        |                              v
        +--bundled fallback--> extension/data/menus.json
                                       |
                    order page (school + delivery date + lines)
                                       v
                          menu window: 6 school days + warnings
```

## Publishing a new month

Run **SNAP Menu Builder** (`tools/menu_tool.py`), choose the workbook the
dietitians published, press Build, then upload the `menus.json` it writes to
`data/` here with GitHub's **Add file -> Upload files**. Installed extensions pick
it up within 12 hours, or immediately via **Refresh** in the menu window.

```bash
pip install -r tools/requirements.txt
python tools/menu_tool.py
```

The workbook itself is never uploaded: it carries cost-per-serving and nutrition
columns, and this repository is public. `menus.json` carries neither - only dates,
serving lines, and item names.

Months accumulate in the tool's workspace folder (`SNAP Menu Builder` in your home
directory), so building October adds to September rather than replacing it, and
rebuilding a revised month replaces just that month. **Start fresh** empties it.

`tools/build.bat` packages the tool as a single `.exe` for a machine without
Python. The same import runs headless:

```bash
python tools/menu_db.py <workbook or folder> --out data
cp data/menus.json extension/data/menus.json   # refresh the offline fallback
```

Each run also writes `menu_flat.csv` (one row per served item, for review in
Excel) and `import_report.txt` (counts, anomalies, and a cross-check against the
workbook's own summary sheet). A month is replaced wholesale when it is
reimported, so a revised workbook cannot leave half of the old one behind.

The repository must stay **public** for the extension to fetch `data/menus.json`
without a token. The menus are already published on schoolcafe.com, so this
exposes nothing that is not public already.

## Repository layout

| Path | What it is |
| --- | --- |
| `tools/menu_tool.py` | SNAP Menu Builder: the desktop window the monthly workbook goes through |
| `tools/menu_db.py` | Reads the workbook, writes `menus.json`, `menus.sqlite`, `menu_flat.csv` and an import report |
| `tools/match_check.mjs` | Dry-runs the missing-item check against a real order, outside the browser |
| `tools/ai_review_check.mjs` | Dry-runs the second look with a stubbed model reply, no key or network needed |
| `extension/config.js` | Where the OpenAI key and the rules sheet id go |
| `data/menus.json` | The published menu file the extension fetches |
| `extension/` | The Chrome extension, loaded unpacked |
| `extension/schools.json` | 288 HISD sites, each with the serving lines it uses |
| `extension/components.json` | Extras an entree needs that its menu name does not mention (a burger's bun) |
| `extension/inject.js` | Puts the order reader into the order tab, only when a button is pressed |

## How the pieces fit

**Menus are keyed by serving line, not by school.** Every HISD school is assigned
serving lines ("K-8 Lunch", "HS Homestyle Lunch"), and menu content depends only
on the line and the date. `extension/schools.json` maps the school name on the
order page to its lines; `data/menus.json` holds one menu per line per day. 286
of the 288 sites resolve to at least one line with a published menu; the two that
do not (Community Services-Sec, ST JOHNS ACADEMY) have no serving line assigned
at all.

**The workbook is read from the per-line grid sheets, not `Menu Item Summary`.**
The summary sheet is already flat and looks like the obvious source, but every
cell in it is a formula, so it reads back empty unless Excel last saved the file
with fresh cached values, and it silently omits the Sack Lunch lines and the
menu category. The grid sheets hold the item name as literal typed text; the
recipe-number lookup the grids do with `VLOOKUP` is redone in Python. The summary
sheet is still read on every import and used to verify the parse.

**Warnings are decided by word matching first, then reviewed by a model.** Menu
names ("Pizza (C), Cheese, 8 Cut") and order lines ("PIZZA, CHEESE THIN CRUST
8-CUT 72SV/CS") both name the food first and describe it afterwards, so a match
requires that leading word plus two thirds of the rest, ignoring pack sizes,
storage codes and anything in parentheses. Where a menu name lists what comes
with a dish ("Beef, Steak Fingers w/Roll") the parts are checked separately.
Condiments are shown but never flagged, and milk is left out of the menu file
altogether because it is ordered separately.

That pass is literal by design, so it flags wording the two sides disagree about
("Broccoli, Butter Buds, Fajita" against "VEG, BROCCOLI FLORETS"). When a key is
set in `extension/config.js`, `extension/menu-ai.js` sends only that shortlist to
`gpt-4o-mini` for a second look, which can **clear** an item but never add one -
so a model failure, or no key at all, leaves the word-matched answer standing.
One request per order, cached, and nothing about it is said in the window: staff
want the answer, not a report on how it was reached. The counts are logged to the
service worker console for troubleshooting.

**Nothing runs in a page until a button is pressed.** The order reader
(`extension/content.js`) used to be declared for every URL, so every tab of every
site loaded it; it is now injected into the order tab on demand by
`extension/inject.js`, and a second injection is a no-op. The popup does not read
the order itself either - it hands over the tab number and opens the menu window,
which does the reading. So pressing **Show Menu** cannot leave the popup sitting
on a page that is mid-postback, and a page that will not answer within five
seconds says so in the window rather than looking stuck. Pressing it again brings
the one menu window forward and re-reads the order instead of opening another.

**The scan outlives the popup.** Chrome closes the popup the moment anything else
is clicked - the menu window especially - and a scan started inside it went with
it, which read as **Scan Order** stopping at "Scanning order..." and never
finishing. `runScan` in `extension/background.js` now owns the scan: the popup
only asks for it and draws the answer, so closing the popup no longer abandons
it, the answer is kept in session storage for the next time the popup is opened,
and a page that never answers times out with a reason instead of nothing.

**Days fold away.** Each day's heading in the menu window is a button that hides
that day, so a day already checked off against the order can be put away and
leave the remaining ones on screen. A folded heading still carries a count of
that day's items that are not on the order, so folding cannot hide a warning, and
the folds are remembered for that delivery date across a **Refresh**.

## Installing the extension

1. `chrome://extensions` -> enable Developer mode -> **Load unpacked** -> pick
   `extension/`.
2. Open a PrimeroEdge order, click the SNAP Agent icon, then **Show Menu for
   These Days**.

If the school name on the order does not match the school list, the window asks
which school it is and remembers the answer. A close-but-wrong guess is never
accepted silently, because the wrong school's menu is worse than no menu.

The menu URL defaults to this repository's `data/menus.json` and can be pointed
elsewhere without a rebuild:

```js
chrome.runtime.sendMessage({ action: "setMenuUrl", url: "https://example.org/menus.json" });
```
