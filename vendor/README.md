# Vendored libraries

These files are committed so the app runs fully offline (no CDN at runtime).

| File | Library | Version | Licence |
|------|---------|---------|---------|
| `xlsx.full.min.js` | [SheetJS Community Edition](https://sheetjs.com) | 0.18.5 | Apache-2.0 |
| `docx.iife.js` | [docx](https://github.com/dolanmiu/docx) | 9.5.1 | MIT |
| `jszip.min.js` | [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT / GPLv3 (dual) |

Licence texts are in `licenses/`.

To update, download the new release from npm (`npm pack <name>@<version>`), copy the
browser build listed above into this folder, and update this table.
