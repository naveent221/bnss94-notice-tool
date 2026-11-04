# BNSS94 Notice Tool

An offline, single-page browser app for police cyber cell staff. It reads the
complaint transaction export from the NCRP portal, finds the **Layer 1**
beneficiary accounts, ranks them, and drafts one **Section 94 BNSS** request
letter per bank (account statement, KYC documents and Account Opening Form),
together with the list of nodal-officer e-mail IDs to send each letter to.

Everything happens inside your browser. There is no server, no upload, no
analytics, and no network access.

## What it does

1. **Upload** the NCRP transaction export (Excel or CSV; one or more files, any
   number of Acknowledgement numbers) and a **Nodal Officers** sheet (bank name,
   IFSC prefix, e-mail IDs).
2. **Map columns.** The tool guesses which column is Ack No, Account No, Bank
   Name, IFSC, Layer, Transaction ID/UTR, Transaction Date, Amount and Disputed
   Amount from the headers. Correct anything wrong; the mapping is remembered
   for next time. Title rows above the header row are skipped automatically.
3. **Layer 1 analysis.** For every Layer 1 account it shows the bank, the
   number and list of Ack numbers it appears in, total disputed amount and
   transaction count. Default order: accounts repeated across the most Ack
   numbers first, then highest disputed amount. The table is sortable and
   filterable (text, repeated only, minimum amount, matched/unmatched), and all
   accounts are ticked by default.
4. **Bank matching.** Each account's bank is matched to the nodal sheet by the
   first 4 characters of the IFSC, then by a fuzzy bank-name match ("HDFC BANK
   LTD." = "HDFC Bank", "SBI" = "State Bank of India"). Unmatched banks and
   banks without an e-mail are listed first in red; pick the right bank or type
   the e-mail ID(s) and the fix is remembered.
5. **Generate**
   - one `.docx` notice per bank, listing all selected accounts at that bank;
   - an Excel summary (`Summary`, `Layer1 Analysis`, `Bank-wise Accounts`,
     `Email Mapping`, `Layer1 Transactions`, `Unmatched Banks`);
   - a ZIP with all of the above plus `Email_List.csv`;
   - an on-screen table of bank → nodal e-mail(s) → attachment file name with a
     **Copy table** button (pastes as a table into Excel, Word or Outlook).

Account and Ack numbers are always handled as text. Spaces and leading
apostrophes are removed and leading zeros are kept. If a spreadsheet stored a
long account number as a number (or shows it as `1.23E+15`), the tool flags it,
because Excel has already lost digits. Re-export that column as Text.

## Running it offline

No installation and no build step are needed.

1. Download or clone this folder (on GitHub: **Code → Download ZIP**) and
   unzip it.
2. Open `index.html` in Chrome, Edge or Firefox (double-click it, or drag it
   into a browser window).
3. Click **Officer settings** once and enter your name, designation, police
   station, phone and e-mail.
4. Load your files. To try the tool first, use the synthetic files in
   `samples/`.

All libraries are in `vendor/` (SheetJS, docx and JSZip; see
[`vendor/README.md`](vendor/README.md)). The page loads nothing from the
internet, so it works on a machine with no connection.

## Data privacy

- Files are read by the browser on your computer. Nothing is uploaded or sent
  anywhere. The page's Content-Security-Policy (`connect-src 'none'`) stops it
  from making any network request, and the end-to-end test checks that none
  are made.
- Complaint data is held only in the open page. Closing or reloading the tab
  (or clicking **Clear data**) discards it.
- The browser's `localStorage` keeps only your officer details, column
  mappings, the notice template, and bank-matching fixes (bank names and
  nodal e-mail IDs). The case reference and notice date are not saved.
- Generated files go to your Downloads folder. Store and delete them according
  to your department's rules.
- **Never commit real data to this repository.** `.gitignore` blocks `*.xlsx`,
  `*.xls`, `*.csv`, `*.docx`, `*.pdf`, `*.zip`, `output/` and `data/`. Only
  the synthetic files in `samples/` are allowed.
- Always check each generated notice before you send it.

## Editing the notice template

Click **Notice template**. The template is plain text:

| Markup | Effect |
|--------|--------|
| one line | one paragraph (blank line = empty paragraph) |
| `[center]` / `[right]` at the start of a line | centre or right-align that line |
| `**text**` | bold |
| `__text__` | underline |
| `{{accounts_table}}` on its own line | table of accounts (S.No, Account No, IFSC, Ack Nos, Disputed Amount, Txns) |

Placeholders (click one to insert it at the cursor):

| Placeholder | Value |
|-------------|-------|
| `{{date}}` | notice date (step 5; default today, DD-MM-YYYY) |
| `{{bank_name}}` | bank name as written in the nodal sheet |
| `{{accounts_table}}` | the accounts table (on its own line); used inline, it gives a comma-separated list of accounts |
| `{{ack_numbers}}` | NCRP Ack numbers covering that bank's accounts |
| `{{officer_name}}`, `{{designation}}`, `{{station}}`, `{{phone}}`, `{{officer_email}}` | from Officer settings |
| `{{case_ref}}` | case / notice reference (step 5) |
| `{{account_count}}`, `{{total_disputed}}` | number of accounts and their total disputed amount |
| `{{nodal_officer}}`, `{{bank_address}}` | from the nodal sheet, if those columns exist |

Click **Save template** to keep your version in this browser. **Export .txt**
and **Import .txt** let you share it with colleagues, and **Restore default**
brings back the built-in Section 94 BNSS text. Use **Preview** to see the
result before generating.

## Nodal officers sheet format

Any layout with a header row works. The tool looks for columns like these:

| Bank Name | IFSC Prefix | Nodal Officer | Email ID | Alternate Email | Address |
|-----------|-------------|---------------|----------|-----------------|---------|

- **Bank Name** and at least one **e-mail** column are required.
- A cell may hold several e-mails separated by `;` or `,`.
- **IFSC Prefix** may hold several prefixes, for banks that merged.
- Rows with the same bank name are merged.

## Development and tests

```bash
node tests/run-tests.js      # analysis logic on the samples (no install needed)
```

```bash
node tests/e2e.js            # drives index.html in headless Chromium (needs Playwright)
```

```bash
node tools/make-samples.js   # regenerate the synthetic samples
```

Code layout:

- `js/analysis.js`: column guessing, normalisation, Layer 1 aggregation, bank
  matching (pure functions, shared by the browser and Node)
- `js/template.js`: default notice text and template parser
- `js/outputs.js`: `.docx`, `.xlsx` and ZIP builders
- `js/app.js`: UI
- `samples/`: synthetic NCRP export (39 rows, 8 Ack nos, 3 layers) and nodal
  sheet; all names, numbers and e-mails are invented

## Licence

MIT for this tool. Vendored libraries keep their own licences (see
`vendor/licenses/`).
