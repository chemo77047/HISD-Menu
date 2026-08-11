# workbooks

Drop each monthly menu workbook the dietitians publish into this folder, through
GitHub's **Add file -> Upload files** button. Nothing else is needed: the
`Build menus` action reimports every workbook here and commits the rebuilt
`data/menus.json`, which is what the extension reads. Watch the run under the
**Actions** tab; `data/import_report.txt` records what parsed and anything odd it
found.

`.xlsm` and `.xlsx` both work, and the file name does not matter - the month
comes from the workbook's own `Menu Master Data` sheet. Uploading a revised
workbook for a month already here replaces that month, as long as it replaces
the file rather than sitting beside it under a different name.

To undo an upload, delete the file; the next run rebuilds without it.
