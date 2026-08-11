"""SNAP Menu Builder - the desktop front end to menu_db.py.

Pick the workbook the dietitians published, press Build, upload the menus.json it
writes to GitHub. That is the whole monthly job.

    pip install -r requirements.txt
    python menu_tool.py

Months accumulate. The workspace folder keeps menus.sqlite between runs, so
building October adds to September rather than replacing it, and rebuilding a
revised month replaces just that month. "Start fresh" empties it.
"""

from __future__ import annotations

import queue
import subprocess
import sys
import threading
from datetime import date
from pathlib import Path

import customtkinter as ctk
from tkinter import filedialog, messagebox

sys.path.insert(0, str(Path(__file__).resolve().parent))
from menu_db import import_workbooks  # noqa: E402

WORKSPACE = Path.home() / "SNAP Menu Builder"
UPLOAD_URL = "https://github.com/chemo77047/HISD-Menu/upload/main/data"

ctk.set_appearance_mode("light")
ctk.set_default_color_theme("green")


def pretty_date(iso: str) -> str:
    year, month, day = (int(part) for part in iso.split("-"))
    return date(year, month, day).strftime("%b %-d, %Y" if sys.platform != "win32"
                                           else "%b %#d, %Y")


def reveal(path: Path) -> None:
    """Open a folder in the system file manager."""
    if sys.platform == "win32":
        subprocess.run(["explorer", str(path)])
    elif sys.platform == "darwin":
        subprocess.run(["open", str(path)])
    else:
        subprocess.run(["xdg-open", str(path)])


class MenuBuilder(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("SNAP Menu Builder")
        self.geometry("760x620")
        self.minsize(680, 560)

        self.workbooks: list[Path] = []
        self.messages: queue.Queue[tuple[str, object]] = queue.Queue()

        self._build_header()
        self._build_steps()
        self._build_log()
        self._build_footer()

        self.after(100, self._drain)
        self._describe_existing()

    # ---------------------------------------------------------------- layout

    def _build_header(self) -> None:
        header = ctk.CTkFrame(self, corner_radius=0, fg_color="#2E86C1")
        header.pack(fill="x")
        ctk.CTkLabel(header, text="SNAP Menu Builder", text_color="white",
                     font=ctk.CTkFont(size=22, weight="bold")).pack(anchor="w", padx=20, pady=(16, 0))
        ctk.CTkLabel(header, text="Turns the monthly menu workbook into the file the "
                                  "SNAP Agent extension reads.",
                     text_color="#EAF2F8").pack(anchor="w", padx=20, pady=(2, 16))

    def _build_steps(self) -> None:
        body = ctk.CTkFrame(self, fg_color="transparent")
        body.pack(fill="x", padx=20, pady=(18, 0))

        ctk.CTkLabel(body, text="1.  Choose the workbook",
                     font=ctk.CTkFont(size=15, weight="bold")).pack(anchor="w")
        row = ctk.CTkFrame(body, fg_color="transparent")
        row.pack(fill="x", pady=(6, 14))
        ctk.CTkButton(row, text="Choose workbook...", width=170,
                      command=self.choose).pack(side="left")
        self.chosen = ctk.CTkLabel(row, text="No workbook chosen", text_color="#666")
        self.chosen.pack(side="left", padx=12)

        ctk.CTkLabel(body, text="2.  Build the menu file",
                     font=ctk.CTkFont(size=15, weight="bold")).pack(anchor="w")
        row2 = ctk.CTkFrame(body, fg_color="transparent")
        row2.pack(fill="x", pady=(6, 14))
        self.build_button = ctk.CTkButton(row2, text="Build menus.json", width=170,
                                          state="disabled", command=self.build)
        self.build_button.pack(side="left")
        self.coverage = ctk.CTkLabel(row2, text="", text_color="#1E8449",
                                     font=ctk.CTkFont(weight="bold"))
        self.coverage.pack(side="left", padx=12)

        ctk.CTkLabel(body, text="3.  Upload it to GitHub",
                     font=ctk.CTkFont(size=15, weight="bold")).pack(anchor="w")
        ctk.CTkLabel(body, text="Open the data folder of the HISD-Menu repository, use "
                               "Add file \u2192 Upload files, drop menus.json in, and commit.\n"
                               "Everyone's extension picks it up within 12 hours, or right "
                               "away with Refresh in the menu window.",
                     justify="left", text_color="#444").pack(anchor="w", pady=(4, 8))
        row3 = ctk.CTkFrame(body, fg_color="transparent")
        row3.pack(fill="x", pady=(0, 4))
        self.folder_button = ctk.CTkButton(row3, text="Show me the file", width=170,
                                          state="disabled", fg_color="#5D6D7E",
                                          hover_color="#48586B", command=self.show_file)
        self.folder_button.pack(side="left")
        self.upload_button = ctk.CTkButton(row3, text="Open GitHub upload page", width=200,
                                          state="disabled", fg_color="#5D6D7E",
                                          hover_color="#48586B", command=self.open_github)
        self.upload_button.pack(side="left", padx=10)

    def _build_log(self) -> None:
        frame = ctk.CTkFrame(self, fg_color="transparent")
        frame.pack(fill="both", expand=True, padx=20, pady=(10, 0))
        self.log_box = ctk.CTkTextbox(frame, font=ctk.CTkFont(family="Courier", size=12))
        self.log_box.pack(fill="both", expand=True)
        self.log_box.configure(state="disabled")

    def _build_footer(self) -> None:
        footer = ctk.CTkFrame(self, fg_color="transparent")
        footer.pack(fill="x", padx=20, pady=12)
        self.status = ctk.CTkLabel(footer, text=f"Workspace: {WORKSPACE}", text_color="#666")
        self.status.pack(side="left")
        ctk.CTkButton(footer, text="Start fresh", width=110, fg_color="#A93226",
                      hover_color="#8C2A1F", command=self.start_fresh).pack(side="right")

    # ----------------------------------------------------------------- state

    def log(self, text: str) -> None:
        """Called from the worker thread as well, so it only queues."""
        self.messages.put(("log", text))

    def _drain(self) -> None:
        while True:
            try:
                kind, payload = self.messages.get_nowait()
            except queue.Empty:
                break
            if kind == "log":
                self.log_box.configure(state="normal")
                self.log_box.insert("end", str(payload) + "\n")
                self.log_box.see("end")
                self.log_box.configure(state="disabled")
            elif kind == "done":
                self._finished(payload)
        self.after(100, self._drain)

    def _describe_existing(self) -> None:
        existing = WORKSPACE / "menus.json"
        if existing.exists():
            self.log(f"A menus.json from an earlier build is already in {WORKSPACE}.")
            self.log("Choosing a workbook and building adds that month to it.\n")
            self.folder_button.configure(state="normal")
            self.upload_button.configure(state="normal")

    # --------------------------------------------------------------- actions

    def choose(self) -> None:
        paths = filedialog.askopenfilenames(
            title="Choose the menu workbook",
            filetypes=[("Excel workbooks", "*.xlsm *.xlsx"), ("All files", "*.*")])
        if not paths:
            return
        self.workbooks = [Path(p) for p in paths]
        names = ", ".join(p.name for p in self.workbooks)
        self.chosen.configure(text=names if len(names) < 70 else f"{len(self.workbooks)} workbooks",
                              text_color="#1E8449")
        self.build_button.configure(state="normal")

    def build(self) -> None:
        self.build_button.configure(state="disabled", text="Building...")
        self.coverage.configure(text="")
        threading.Thread(target=self._build_worker, daemon=True).start()

    def _build_worker(self) -> None:
        try:
            payload = import_workbooks(self.workbooks, WORKSPACE, log=self.log)
            self.messages.put(("done", payload))
        except Exception as error:              # a crash must not kill the window
            self.log(f"\nFAILED: {error}")
            self.messages.put(("done", None))

    def _finished(self, payload: dict | None) -> None:
        self.build_button.configure(state="normal", text="Build menus.json")
        if not payload:
            messagebox.showerror("SNAP Menu Builder",
                                 "The workbook could not be read. The log has the details.")
            return
        self.coverage.configure(
            text=f"{pretty_date(payload['firstDate'])} \u2013 {pretty_date(payload['lastDate'])}"
                 f"  ({payload['servingDayCount']} serving days)")
        self.folder_button.configure(state="normal")
        self.upload_button.configure(state="normal")
        self.log("\nmenus.json is ready. Upload it to the data folder on GitHub.")

    def show_file(self) -> None:
        reveal(WORKSPACE)

    def open_github(self) -> None:
        import webbrowser
        webbrowser.open(UPLOAD_URL)

    def start_fresh(self) -> None:
        if not messagebox.askyesno(
                "Start fresh",
                "Forget every month built so far?\n\n"
                "The next build starts from only the workbooks you choose. "
                "The menus.json already uploaded to GitHub is not affected."):
            return
        for name in ("menus.sqlite", "menus.json", "menu_flat.csv", "import_report.txt"):
            (WORKSPACE / name).unlink(missing_ok=True)
        self.log("Workspace emptied.")
        self.coverage.configure(text="")
        self.folder_button.configure(state="disabled")
        self.upload_button.configure(state="disabled")


if __name__ == "__main__":
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    MenuBuilder().mainloop()
