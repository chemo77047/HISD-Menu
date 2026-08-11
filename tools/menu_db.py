"""Turn the dietitians' monthly menu workbook into a usable menu database.

Drop one workbook or a folder of them:

    python menu_db.py "26-27 Sept Menu.xlsm"
    python menu_db.py ./workbooks --out ../data

Produces, in the output folder:

    menus.json         what the SNAP Agent extension fetches
    menus.sqlite       queryable database, accumulates across months
    menu_flat.csv      one row per served item, for review in Excel
    import_report.txt  what parsed, what did not, and every anomaly

Re-importing a revised workbook for a month it has already seen replaces that
month's rows rather than duplicating them, so a revision can be dropped in
safely at any time.

Why the per-line grid sheets and not 'Menu Item Summary':
'Menu Item Summary' looks like the obvious source because it is already flat,
but every one of its cells is a formula pointing back into a grid sheet. Reading
it means trusting Excel's cached results, which come back empty if the workbook
was last saved by anything that does not recalculate (LibreOffice, Sheets, most
scripting libraries). It also omits the Sack Lunch lines entirely and has no
menu category column. The grid sheets hold the item name as literal typed text
plus the category, so they are read directly and the recipe number lookup that
'Primero Data' does with VLOOKUP is redone here in Python.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required:  pip install openpyxl")


# Sheets that are not per-line menu grids.
NON_MENU_SHEETS = {
    "Menu Master Data", "Menu Cost Summary", "Primero Data", "Nutri Data",
    "AF Table", "Menu Item Summary", "Daily Pre-Cost", "Conversion", "mapping",
}

# Sheet tab names do not always match the serving-line names schools are
# assigned to in SchoolCafe, and the extension looks menus up by the latter.
# Everything not listed here matches already.
LINE_ALIASES = {
    "Breakfast SS PreK": "Breakfast SS Pre-K",
    "PreK Lunch SS": "Pre-K Lunch SS",
    "MS Favorites": "MS Snack Favorites",
    "HS Favorites": "HS Snack Favorites",
    "HS Deli & Salad": "HS Deli and Salad",
}

# Milk is delivered on a separate dairy order, so it is left out of the file the
# extension reads. It is still kept in the database and the CSV.
EXCLUDED_CATEGORIES = {"milk"}

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
WEEK_HEADER_RE = re.compile(r"^\s*Week\s*(\d+)", re.I)
WEEKDAY_HEADER_RE = re.compile(r"^\s*(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY)", re.I)
# "Sep  7th - Sep 11th", "Sep 28th - Oct  2nd"
WEEK_RANGE_RE = re.compile(r"^\s*([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?", re.I)
MONTH_YEAR_RE = re.compile(r"^\s*([A-Za-z]+)\s+(\d{4})\s*$")
# Trailing school-year marker on every item name: "Muffin, Corn (IW) 25-26"
YEAR_SUFFIX_RE = re.compile(r"\s*\b\d{2}-\d{2}\b\s*$")

MONTHS = {m.lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"], start=1)}
for _name, _num in list(MONTHS.items()):
    MONTHS[_name[:3]] = _num


def meal_for_line(line: str) -> str:
    lowered = line.lower()
    if "breakfast" in lowered:
        return "Breakfast"
    if "snack" in lowered:
        return "Snack"
    if "dinner" in lowered:
        return "Dinner"
    return "Lunch"


def clean_name(name: str) -> str:
    return YEAR_SUFFIX_RE.sub("", " ".join(name.split())).strip()


@dataclass
class MenuRecord:
    serving_line: str
    canonical_line: str
    serve_date: str
    meal: str
    category: str
    recipe_no: str | None
    item_name: str
    display_name: str


class WorkbookParser:
    def __init__(self, path: Path):
        self.path = path
        self.warnings: list[str] = []
        # data_only=True gives cached values, needed for 'Primero Data' and for
        # cross-checking 'Menu Item Summary'. Item names in the grids are
        # literal text either way.
        self.wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        self.month_label, self.revision = self._read_master_data()
        self.week_starts = self._read_week_starts()
        self.recipe_by_name, self.recipes = self._read_primero_data()

    # ------------------------------------------------------------------ header

    def _read_master_data(self) -> tuple[str, str | None]:
        ws = self.wb["Menu Master Data"]
        rows = {r[0]: r[1] for r in ws.iter_rows(min_col=1, max_col=2, values_only=True)
                if isinstance(r[0], str)}
        month = next((v for k, v in rows.items() if k.strip().lower().startswith("month")), None)
        revision = next((v for k, v in rows.items() if "revision" in k.strip().lower()), None)
        if not isinstance(month, str) or not MONTH_YEAR_RE.match(month):
            raise ValueError(f"{self.path.name}: could not read month from 'Menu Master Data'")
        if isinstance(revision, datetime):
            revision = revision.isoformat(sep=" ")
        return month.strip(), (str(revision) if revision else None)

    def _read_week_starts(self) -> dict[int, date]:
        """Monday of each published week, from the 'Week N' ranges on the master sheet."""
        m = MONTH_YEAR_RE.match(self.month_label)
        base_month, year = MONTHS[m.group(1).lower()], int(m.group(2))

        ws = self.wb["Menu Master Data"]
        starts: dict[int, date] = {}
        for row in ws.iter_rows(min_col=1, max_col=2, values_only=True):
            label, value = row[0], row[1]
            if not isinstance(label, str) or not isinstance(value, str):
                continue
            week_match = WEEK_HEADER_RE.match(label)
            range_match = WEEK_RANGE_RE.match(value)
            if not week_match or not range_match:
                continue
            month_name, day = range_match.group(1).lower(), int(range_match.group(2))
            if month_name[:3] not in MONTHS:
                self.warnings.append(f"unrecognised month in week range: {value!r}")
                continue
            month = MONTHS[month_name[:3]]
            # A week range starting in the next calendar year rolls the year over.
            week_year = year + 1 if month < base_month and base_month == 12 else year
            start = date(week_year, month, day)
            if start.weekday() != 0:
                self.warnings.append(
                    f"Week {week_match.group(1)} starts {start} which is a "
                    f"{WEEKDAYS[start.weekday()] if start.weekday() < 5 else 'weekend day'}, "
                    "not a Monday")
            starts[int(week_match.group(1))] = start
        if not starts:
            raise ValueError(f"{self.path.name}: no 'Week N' date ranges on 'Menu Master Data'")
        return starts

    def _read_primero_data(self) -> tuple[dict[str, str], dict[str, dict]]:
        """Recipe catalog: the lookup table the grids' VLOOKUP formulas use."""
        by_name: dict[str, str] = {}
        recipes: dict[str, dict] = {}
        for row in self.wb["Primero Data"].iter_rows(min_row=2, max_col=5, values_only=True):
            code, name, serving, cost, number = (row + (None,) * 5)[:5]
            if not name or number is None:
                continue
            recipe_no = str(int(number)) if isinstance(number, (int, float)) else str(number).strip()
            by_name[str(name).strip()] = recipe_no
            recipes[recipe_no] = {
                "recipe_no": recipe_no,
                "primero_code": str(code).strip() if code else None,
                "name": str(name).strip(),
                "serving_size": str(serving).strip() if serving else None,
                "cost_per_serving": float(cost) if isinstance(cost, (int, float)) else None,
            }

        nutri = self.wb["Nutri Data"] if "Nutri Data" in self.wb.sheetnames else None
        if nutri:
            for row in nutri.iter_rows(min_row=2, max_col=7, values_only=True):
                _, _, number, cal, sodium, sat_fat, sugar = (row + (None,) * 7)[:7]
                if number is None:
                    continue
                key = str(int(number)) if isinstance(number, (int, float)) else str(number).strip()
                if key in recipes:
                    recipes[key].update(calories=cal, sodium=sodium,
                                        sat_fat=sat_fat, added_sugar=sugar)
        return by_name, recipes

    # ------------------------------------------------------------------- grids

    def parse(self) -> list[MenuRecord]:
        records: list[MenuRecord] = []
        for sheet in self.wb.sheetnames:
            if sheet in NON_MENU_SHEETS:
                continue
            records.extend(self._parse_sheet(sheet))
        return records

    def _parse_sheet(self, sheet: str) -> list[MenuRecord]:
        grid = [list(r) for r in self.wb[sheet].iter_rows(values_only=True)]
        if not grid:
            return []

        def cell(row: int, col: int):
            """1-based, tolerant of ragged rows."""
            if not 1 <= row <= len(grid):
                return None
            values = grid[row - 1]
            return values[col - 1] if 1 <= col <= len(values) else None

        week_rows = self._find_week_headers(grid)
        if not week_rows:
            self.warnings.append(f"{sheet}: no 'Week N' header found, sheet skipped")
            return []

        meal = meal_for_line(sheet)
        records: list[MenuRecord] = []

        for position, (week_no, header_row) in enumerate(week_rows):
            end_row = week_rows[position + 1][1] - 1 if position + 1 < len(week_rows) else len(grid)
            start = self.week_starts.get(week_no)
            if start is None:
                continue  # a week with no date range is an unused template week

            day_columns = self._find_day_columns(grid, header_row)
            if not day_columns:
                self.warnings.append(f"{sheet}: week {week_no} has no weekday headers")
                continue

            categories = self._category_rows(cell, header_row, end_row)
            for weekday_index, col in day_columns:
                serve_date = start + timedelta(days=weekday_index)
                for row, category in categories.items():
                    name = cell(row, col)
                    if not isinstance(name, str) or not name.strip():
                        continue
                    recipe_no = self._resolve_recipe(cell(row, col + 1), name)
                    if recipe_no is None:
                        self.warnings.append(
                            f"{sheet} {serve_date} {category}: no recipe number for {name.strip()!r}")
                    records.append(MenuRecord(
                        serving_line=sheet,
                        canonical_line=LINE_ALIASES.get(sheet, sheet),
                        serve_date=serve_date.isoformat(),
                        meal=meal,
                        category=category,
                        recipe_no=recipe_no,
                        item_name=name.strip(),
                        display_name=clean_name(name),
                    ))
        return records

    @staticmethod
    def _find_week_headers(grid) -> list[tuple[int, int]]:
        found = []
        for index, values in enumerate(grid, start=1):
            first = values[0] if values else None
            if isinstance(first, str):
                match = WEEK_HEADER_RE.match(first)
                if match:
                    found.append((int(match.group(1)), index))
        return found

    @staticmethod
    def _find_day_columns(grid, header_row: int) -> list[tuple[int, int]]:
        """Weekday index -> 1-based column of that day's item-name column."""
        values = grid[header_row - 1] if header_row - 1 < len(grid) else []
        columns = []
        for offset, value in enumerate(values, start=1):
            if isinstance(value, str):
                match = WEEKDAY_HEADER_RE.match(value)
                if match:
                    columns.append((WEEKDAYS.index(match.group(1).capitalize()), offset))
        return columns

    @staticmethod
    def _category_rows(cell, header_row: int, end_row: int) -> dict[int, str]:
        """Row -> menu category, forward-filled down each labelled block.

        Lunch sheets put the category in column C and the slot number in B;
        breakfast sheets are the other way round. The category column is
        whichever of the two holds text.
        """
        categories: dict[int, str] = {}
        current: str | None = None
        for row in range(header_row, end_row + 1):
            label = next(
                (value.strip() for value in (cell(row, 3), cell(row, 2))
                 if isinstance(value, str) and value.strip()),
                None)
            if label:
                if "WEEKLY" in label.upper() or label.lower().startswith("last modified"):
                    current = None
                    continue
                current = label
            if current:
                categories[row] = current
        return categories

    def _resolve_recipe(self, cached, name: str) -> str | None:
        """Prefer the catalog lookup; fall back to the sheet's cached formula value."""
        looked_up = self.recipe_by_name.get(name.strip())
        if looked_up:
            return looked_up
        if isinstance(cached, (int, float)):
            return str(int(cached))
        if isinstance(cached, str) and cached.strip().isdigit():
            return cached.strip()
        return None

    # -------------------------------------------------------------- validation

    def cross_check(self, records: list[MenuRecord]) -> list[str]:
        """Compare against the workbook's own summary sheet, when it is readable."""
        if "Menu Item Summary" not in self.wb.sheetnames:
            return ["'Menu Item Summary' not present, parse not cross-checked"]

        summary = set()
        for row in self.wb["Menu Item Summary"].iter_rows(min_row=2, max_col=7, values_only=True):
            served, recipe, _, _, _, line, _ = (row + (None,) * 7)[:7]
            if served is None or recipe is None or not line:
                continue
            served_date = served.date().isoformat() if isinstance(served, datetime) else str(served)
            summary.add((str(line).strip(), served_date, str(recipe).strip()))

        if not summary:
            return ["'Menu Item Summary' read back empty (formula values not cached) "
                    "- parse not cross-checked, which is exactly why it is not the data source"]

        summary = {(LINE_ALIASES.get(line, line), served, recipe)
                   for line, served, recipe in summary}
        mine = {(r.canonical_line, r.serve_date, r.recipe_no) for r in records if r.recipe_no}
        only_summary = summary - mine
        only_mine = mine - summary

        notes = [f"cross-check vs 'Menu Item Summary': {len(summary)} summary rows, "
                 f"{len(mine)} parsed rows, {len(only_summary)} only in summary, "
                 f"{len(only_mine)} only in parse"]
        for item in sorted(only_summary)[:20]:
            notes.append(f"  only in summary: {item}")
        if len(only_summary) > 20:
            notes.append(f"  ... and {len(only_summary) - 20} more")
        # Lines the summary sheet is known to omit show up here as parse-only and
        # are expected, so they are counted rather than listed.
        lines_only_mine = sorted({item[0] for item in only_mine})
        if lines_only_mine:
            notes.append("  lines present in parse but not in summary: " + ", ".join(lines_only_mine))
        return notes


# ------------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS source_file (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  month_label TEXT,
  revision TEXT,
  sha256 TEXT,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe (
  recipe_no TEXT PRIMARY KEY,
  primero_code TEXT,
  name TEXT,
  serving_size TEXT,
  cost_per_serving REAL,
  calories REAL,
  sodium REAL,
  sat_fat REAL,
  added_sugar REAL
);
CREATE TABLE IF NOT EXISTS menu_item (
  serving_line TEXT NOT NULL,
  canonical_line TEXT NOT NULL,
  serve_date TEXT NOT NULL,
  meal TEXT NOT NULL,
  category TEXT NOT NULL,
  recipe_no TEXT,
  item_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_file_id INTEGER,
  PRIMARY KEY (serving_line, serve_date, category, item_name)
);
CREATE INDEX IF NOT EXISTS menu_item_date ON menu_item (serve_date);
"""


def write_database(db_path: Path, parser: WorkbookParser, records: list[MenuRecord]) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    try:
        connection.executescript(SCHEMA)
        digest = hashlib.sha256(parser.path.read_bytes()).hexdigest()
        cursor = connection.execute(
            "INSERT INTO source_file (filename, month_label, revision, sha256, imported_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (parser.path.name, parser.month_label, parser.revision, digest,
             datetime.now().isoformat(timespec="seconds")))
        source_id = cursor.lastrowid

        # Replace whole (line, date) groups so a revised workbook supersedes the
        # month it covers instead of merging into it and leaving dropped items behind.
        groups = sorted({(r.serving_line, r.serve_date) for r in records})
        connection.executemany(
            "DELETE FROM menu_item WHERE serving_line = ? AND serve_date = ?", groups)

        connection.executemany(
            "INSERT OR REPLACE INTO menu_item (serving_line, canonical_line, serve_date, meal, "
            "category, recipe_no, item_name, display_name, source_file_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(r.serving_line, r.canonical_line, r.serve_date, r.meal, r.category, r.recipe_no,
              r.item_name, r.display_name, source_id) for r in records])

        connection.executemany(
            "INSERT OR REPLACE INTO recipe (recipe_no, primero_code, name, serving_size, "
            "cost_per_serving, calories, sodium, sat_fat, added_sugar) "
            "VALUES (:recipe_no, :primero_code, :name, :serving_size, :cost_per_serving, "
            ":calories, :sodium, :sat_fat, :added_sugar)",
            [{"calories": None, "sodium": None, "sat_fat": None, "added_sugar": None, **recipe}
             for recipe in parser.recipes.values()])
        connection.commit()
    finally:
        connection.close()


def export_json(db_path: Path, json_path: Path) -> dict:
    """Extension-facing view: serving line -> date -> items, plus a coverage summary."""
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        lines: dict[str, dict[str, list[dict]]] = {}
        meals: dict[str, str] = {}
        placeholders = ", ".join("?" for _ in EXCLUDED_CATEGORIES)
        for row in connection.execute(
                "SELECT canonical_line, serve_date, meal, category, recipe_no, display_name "
                f"FROM menu_item WHERE lower(category) NOT IN ({placeholders}) "
                "ORDER BY canonical_line, serve_date, category, display_name",
                sorted(EXCLUDED_CATEGORIES)):
            by_date = lines.setdefault(row["canonical_line"], {})
            by_date.setdefault(row["serve_date"], []).append({
                "recipe": row["recipe_no"],
                "name": row["display_name"],
                "category": row["category"],
            })
            meals[row["canonical_line"]] = row["meal"]

        dates = [row[0] for row in connection.execute(
            "SELECT DISTINCT serve_date FROM menu_item ORDER BY serve_date")]
        sources = [dict(row) for row in connection.execute(
            "SELECT filename, month_label, revision, imported_at FROM source_file "
            "ORDER BY imported_at")]
    finally:
        connection.close()

    payload = {
        "version": 1,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "firstDate": dates[0] if dates else None,
        "lastDate": dates[-1] if dates else None,
        "servingDayCount": len(dates),
        "meals": meals,
        "sources": sources,
        "lines": lines,
    }
    json_path.parent.mkdir(parents=True, exist_ok=True)
    # Compact: this file is downloaded by every install, and grows with each month.
    json_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return payload


def export_csv(db_path: Path, csv_path: Path) -> None:
    connection = sqlite3.connect(db_path)
    try:
        rows = connection.execute(
            "SELECT serve_date, canonical_line, serving_line, meal, category, recipe_no, "
            "display_name, item_name FROM menu_item "
            "ORDER BY serve_date, canonical_line, category, display_name").fetchall()
    finally:
        connection.close()
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["serve_date", "serving_line", "sheet_name", "meal", "category",
                         "recipe_no", "display_name", "item_name_as_typed"])
        writer.writerows(rows)


# ----------------------------------------------------------------------- main

def workbooks_in(target: Path) -> list[Path]:
    if target.is_dir():
        return sorted(p for p in target.iterdir()
                      if p.suffix.lower() in (".xlsm", ".xlsx") and not p.name.startswith("~$"))
    return [target]


def main(argv: list[str] | None = None) -> int:
    arguments = argparse.ArgumentParser(description=__doc__,
                                        formatter_class=argparse.RawDescriptionHelpFormatter)
    arguments.add_argument("target", type=Path, help="workbook, or folder of workbooks")
    arguments.add_argument("--out", type=Path, default=Path("out"), help="output folder")
    parsed = arguments.parse_args(argv)

    files = workbooks_in(parsed.target)
    if not files:
        print(f"no .xlsm/.xlsx files found in {parsed.target}")
        return 1

    parsed.out.mkdir(parents=True, exist_ok=True)
    db_path = parsed.out / "menus.sqlite"
    report: list[str] = []

    for path in files:
        print(f"reading {path.name} ...")
        try:
            parser = WorkbookParser(path)
            records = parser.parse()
        except Exception as error:  # a bad workbook must not lose the others
            print(f"  FAILED: {error}")
            report += [f"=== {path.name}", f"  FAILED: {error}", ""]
            continue

        write_database(db_path, parser, records)

        by_line: dict[str, set[str]] = {}
        for record in records:
            by_line.setdefault(record.serving_line, set()).add(record.serve_date)
        missing_recipe = sum(1 for r in records if not r.recipe_no)

        print(f"  {parser.month_label}: {len(records)} items across "
              f"{len(by_line)} lines, {len({r.serve_date for r in records})} serving days")
        if missing_recipe:
            print(f"  {missing_recipe} items without a recipe number")

        report += [
            f"=== {path.name}",
            f"  month: {parser.month_label}   revision: {parser.revision}",
            f"  items: {len(records)}   lines: {len(by_line)}   "
            f"serving days: {len({r.serve_date for r in records})}",
            f"  items without a recipe number: {missing_recipe}",
            "  per line:",
        ]
        for line in sorted(by_line):
            report.append(f"    {line:34s} {len(by_line[line]):3d} days")
        report += ["  cross-check:"] + [f"  {note}" for note in parser.cross_check(records)]
        if parser.warnings:
            report += ["  warnings:"] + [f"    {w}" for w in parser.warnings]
        report.append("")

    payload = export_json(db_path, parsed.out / "menus.json")
    export_csv(db_path, parsed.out / "menu_flat.csv")

    summary = (f"database now covers {payload['servingDayCount']} serving days "
               f"({payload['firstDate']} to {payload['lastDate']}) "
               f"across {len(payload['lines'])} serving lines")
    print(summary)
    (parsed.out / "import_report.txt").write_text(
        "\n".join(report + [summary, ""]), encoding="utf-8")
    print(f"wrote {parsed.out}/menus.json, menus.sqlite, menu_flat.csv, import_report.txt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
