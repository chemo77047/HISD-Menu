# HISD-Menu

Menu data and Chrome extension for **SNAP Agent**, used by Houston ISD Nutrition
Services while placing food orders in PrimeroEdge.

While an order is open, SNAP Agent shows what is on the menu for the delivery
date and the next five school days, and points out entrees and sides on those
days that nothing on the order appears to cover. Nobody has to leave the order
screen to look a menu up.

```
workbooks/26-27 Sept Menu.xlsm  (uploaded through GitHub)
        |  Build menus action -> tools/menu_db.py
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

Upload the workbook the dietitians publish into [`workbooks/`](workbooks) using
GitHub's **Add file -> Upload files**. That is the whole job: the `Build menus`
action reimports the folder and commits the rebuilt `data/menus.json` and the
extension's offline copy. Installed extensions pick it up within 12 hours, or
immediately via **Refresh** in the menu window.

Locally, the same thing:

```bash
pip install -r tools/requirements.txt
python tools/menu_db.py workbooks --out data
cp data/menus.json extension/data/menus.json   # refresh the offline fallback
```

Each run also writes `menu_flat.csv` (one row per served item, for review in
Excel) and `import_report.txt` (counts, anomalies, and a cross-check against the
workbook's own summary sheet). Every workbook in the folder is reimported on each
run, so the published menu depends only on the folder's contents and a bad upload
is undone by deleting the file.

The repository must stay **public** for the extension to fetch `data/menus.json`
without a token. The menus are already published on schoolcafe.com, so this
exposes nothing that is not public already.

## Repository layout

| Path | What it is |
| --- | --- |
| `workbooks/` | The monthly workbooks, as uploaded |
| `tools/menu_db.py` | Reads the workbook, writes `menus.json`, `menus.sqlite`, `menu_flat.csv` and an import report |
| `tools/match_check.mjs` | Dry-runs the missing-item check against a real order, outside the browser |
| `data/menus.json` | The published menu file the extension fetches |
| `extension/` | The Chrome extension, loaded unpacked |
| `extension/schools.json` | 288 HISD sites, each with the serving lines it uses |
| `extension/components.json` | Extras an entree needs that its menu name does not mention (a burger's bun) |

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

**Warnings are rule-based, not model-based.** Menu names ("Pizza (C), Cheese, 8
Cut") and order lines ("PIZZA, CHEESE THIN CRUST 8-CUT 72SV/CS") both name the
food first and describe it afterwards, so a match requires that leading word plus
two thirds of the rest. The same order therefore always produces the same
warnings, at no cost, and a menu item can never be invented. Where a menu name
already lists what comes with a dish ("Beef, Steak Fingers w/Roll") the parts are
checked separately. Condiments are shown but never flagged, and milk is left out
of the menu file altogether because it is ordered separately.

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
