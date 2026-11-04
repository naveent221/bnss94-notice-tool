# BNSS94 Notice Tool

An offline, single-page browser app for police cyber cell staff. It covers
Phase 1 of the cyber-fraud workflow:

1. Take the transaction data collected from the NCRP portal (Excel/CSV): Layer
   1, 2, 3… accounts, transaction IDs, disputed and put-on-hold amounts, and
   suspect mobile numbers, URLs and social media / UPI IDs.
2. Store it against the **FIR number** together with the **FIR copy**, and
   prompt for any mandatory field that is missing.
3. Draft **Section 94 BNSS notices** to the nodal officer of every bank,
   payment entity, telecom operator and platform involved. Each notice requests
   the documents that suit that recipient: account statement, KYC, AOF,
   photographs, Aadhaar, PAN, CDR, SDR/CAF, IPDR, IP logs and so on.
4. **Send the notices by e-mail** from the officer's own mailbox, with the
   notice and FIR copy attached and the nodal officer's address filled in.
   This uses the optional [mail helper](#mail-helper-automatic-sending-and-replies);
   without it, the app produces ready-to-send e-mail drafts instead.
5. **Prompt when a nodal officer replies.** With the mail helper, replies are
   picked up from the mailbox automatically. Each reply is matched to its
   notice, its attachments are saved with the case, and overdue notices are
   flagged.

Everything happens on your own computer. The app itself has no server and
does no uploading or analytics. The only network connection is the optional
mail helper talking to **your own mail server**.

## How it works

### Cases dashboard

- **Alerts**: replies waiting for review, notices past their reply date,
  notices due within a day, and cases with mandatory fields missing. These are
  also shown in a pop-up each time the app is opened.
- **Replies from nodal officers**: drop reply e-mails (`.eml`) here (see
  [Replies](#replies)).
- **Cases**: every saved case by FIR number, with counts of notices, sent,
  replies, overdue and missing fields.
  - **Backup all cases** downloads a single `.bnss94.json` file containing
    cases, FIR copies and replies.
  - **Restore backup** loads one, for example on another computer.
- **Nodal officers directory**: upload the nodal officers sheet once; every
  case uses it.

### A case

1. **FIR details.** FIR number, FIR date, police station and sections of law
   are mandatory, and so is the FIR copy (PDF or image). You can also enter the
   complainant(s) and a records period, which is used in CDR / IPDR / IP-log
   requests.
   - The **Mandatory fields** list ticks each item as it is filled. In red it
     lists anything still missing: FIR fields, FIR copy, NCRP export, officer
     details, rows without bank name or amount, and recipients without a nodal
     officer or e-mail.
   - Generating notices with items missing asks for confirmation first.
2. **NCRP transaction export.** Upload one or more Excel/CSV files and map the
   columns. They are guessed from the headers, and your choices are remembered.
   - Required: Ack No, Account No and Bank Name.
   - Optional: IFSC, Layer, Transaction ID/UTR, Transaction Date, Amount,
     Disputed Amount, **Put on Hold Amount**, **Suspect Mobile No(s)**,
     **Suspect URL(s)** and **Suspect Social Media / UPI / E-mail ID(s)**.
   - All rows and columns are stored with the case.
3. **Layer 1 accounts.**
   - Totals for the case: **total loss** (Layer 1 disputed amount) and **total
     put on hold**, plus a per-Ack summary.
   - For each Layer 1 account: its bank, how many Ack numbers it appears in and
     which ones, total disputed amount and transaction count.
   - Accounts are ranked by repeat count, then disputed amount. The table is
     sortable and filterable, and all accounts are selected by default.
4. **Phone numbers, URLs, social media / UPI / e-mail IDs.** These come from
   the mapped suspect columns. You can also paste more.
   - URLs, e-mail IDs and UPI IDs are matched to a platform or payment entity
     through the **Domains / UPI handles** column of the nodal sheet.
   - Mobile numbers need their operator (TSP) chosen. Number series are
     unreliable because of portability. **Assign all unassigned mobile numbers
     to …** does them in one go.
5. **Recipients & documents requested.** There is one notice per nodal
   officer. A payment bank that has both an account and a UPI ID gets one
   notice with both tables.
   - Requested documents are ticked by default according to the recipient's
     category, and you can change them for each recipient:

     | Category | Requested by default |
     |---|---|
     | Bank | Account statement, KYC, AOF, photographs, Aadhaar, PAN |
     | Payment / wallet | The bank items, plus linked accounts |
     | Telecom | KYC, photographs, Aadhaar, CDR, SDR/CAF, IPDR |
     | Platform | Registration / subscriber details, IP logs, linked accounts |

   - Banks are matched by IFSC prefix, then by fuzzy name. Anything unmatched
     is shown in red so you can pick the right nodal officer or type the
     e-mail.
6. **Generate & send.**
   - **Download ZIP** contains:
     - `Notices/*.docx`: one notice per recipient;
     - `Email_Drafts/*.eml`: one e-mail draft per recipient;
     - the FIR copy;
     - `BNSS94_Summary.xlsx`;
     - `Email_List.csv`.
   - Each notice gets a unique reference such as **`N94-123.2026-04`**. It
     appears in the notice and in the e-mail subject.
   - Use the **Notice register** to set each notice to *Sent*, which starts its
     reply countdown (default 7 days). From then on it shows as *Reply
     received*, *Partial reply* or *Closed*.

### Sending the e-mails

Each notice has its own **Send** button, and **Send all by e-mail** sends every
notice that has not been sent yet.

- These buttons need the
  [mail helper](#mail-helper-automatic-sending-and-replies) to be running and
  set up.
- Before anything is sent, you see the list of recipients and are asked to
  confirm.
- Each e-mail carries the notice (`.docx`) and the FIR copy. A copy is saved
  in your Sent folder.
- After sending, the notice's status becomes *Sent* and its reply countdown
  starts.

Without the mail helper, use the `.eml` drafts from the ZIP (or each row's
**E-mail draft** button). Each draft has the To address, subject, body and
both attachments already filled in:

- **Outlook (desktop)**: double-click the `.eml`. It opens as a new message
  ready to send (the file carries the `X-Unsent` flag). Check it and press
  **Send**.
- **Thunderbird**: open the `.eml`, then use **Edit as New Message**.
- **Webmail**: use the **Copy e-mails** button and attach the `.docx` and FIR
  copy from the ZIP.

Afterwards set the notice to *Sent* in the register.

### Replies

With the mail helper, replies are found in your inbox automatically, every few
minutes. **Check mailbox now** on the Cases page checks straight away. The
helper reads messages without marking them as read, so your mail client still
shows them as new.

Without the helper, save the reply as `.eml` (in Outlook use *Save As*; in
webmail, *Download message* or *Show original → Download*) and drop it on the
Cases page.

Either way, each reply is matched to its notice in this order:

1. by **e-mail threading**: the reply's `In-Reply-To` / `References` point to
   the notice the helper sent, even if the bank changed the subject;
2. by the **`N94-…` reference** in the subject, which a normal "Reply" keeps;
3. by the sender's e-mail address or domain.

What happens next:
- If the app can't decide, the e-mail goes to **Unmatched replies** on the
  Cases page. You pick the notice there, or discard it.
- Attachments are saved with the FIR. The notice shows **Reply received**,
  and a pop-up tells you which FIR and bank it belongs to.
- The same e-mail is never recorded twice.
- Replies sent by post or in other formats can be added with **Attach reply
  files to a notice…**.

Account and Ack numbers are always handled as text, so leading zeros are kept.
If a spreadsheet stored a long account number as a number (or shows it as
`1.23E+15`), the tool flags it, because Excel has already lost digits.
Re-export that column as Text.

## Running it offline

No installation and no build step are needed.

1. Download or clone this folder (on GitHub: **Code → Download ZIP**) and
   unzip it.
2. Open `index.html` in Chrome or Edge (double-click it, or drag it into a
   browser window). Firefox works too.
3. Click **Officer settings** once and enter your name, designation, unit,
   phone and official e-mail.
4. On **Cases**, upload the nodal officers sheet, then click **New case**.

To try the tool, use the synthetic files in `samples/`:
- `sample_nodal_officers.xlsx`;
- `sample_fir_copy.pdf`;
- `sample_ncrp_export.xlsx`.

All libraries are in `vendor/` (SheetJS, docx and JSZip; see
[`vendor/README.md`](vendor/README.md)). The page loads nothing from the
internet.

## Mail helper (automatic sending and replies)

A web page cannot send e-mail or read a mailbox by itself, so the tool comes
with a small companion program, the **mail helper** (`mail-helper/`).

- It runs on the officer's own computer and listens only on `127.0.0.1`.
- It sends notices through your mail server (SMTP) and checks your inbox for
  replies (IMAP).
- It needs [Node.js](https://nodejs.org) 18 or newer (LTS) and nothing else.
  There is no `npm install` step.

**Start it**

- Windows: double-click `mail-helper\Start-Mail-Helper.bat`.
- Linux / macOS: run `mail-helper/start-mail-helper.sh`.

The window shows a **pairing code**. Keep the window open while you work.

**Set it up in the app** (once): click **Mail** in the top bar.

1. Enter the pairing code and click **Connect**.
2. Fill in:
   - your name and official e-mail;
   - your login and password;
   - the SMTP and IMAP server names and ports.
3. Click **Save & test connection**. Both checks should say **OK**. The header
   then shows **Mail: connected**.

**Server settings**

| Mail service | SMTP (sending) | IMAP (mailbox) | Notes |
|---|---|---|---|
| Gmail / Google Workspace | `smtp.gmail.com` 465 SSL/TLS | `imap.gmail.com` 993 SSL/TLS | Turn on 2-step verification and create an **app password** |
| Microsoft 365 / Outlook.com | `smtp.office365.com` 587 STARTTLS | `outlook.office365.com` 993 SSL/TLS | Your admin must allow SMTP AUTH and IMAP for the mailbox |
| Official / departmental mail | ask your mail administrator | ask your mail administrator | Confirm that SMTP and IMAP access is allowed for your account |

**Security**
- **Pairing code:** every request from the app must carry it, so other web
  pages cannot use the helper. Requests for other host names or from other
  websites are also refused.
- **Password:** kept in the helper's memory and never stored in the browser.
  It is written to disk (`%APPDATA%\BNSS94MailHelper\config.json`, or
  `~/.bnss94-mail-helper/`) only if you tick *Remember password*. Otherwise
  you enter it again after restarting the helper.
- **Encryption:** the helper refuses to send your password over an
  unencrypted connection, and it verifies the server's certificate unless you
  tick the *internal / self-signed certificate* box.
- **Sending:** nothing is sent without your confirmation.
- **Replies:** found replies wait in the helper's settings folder (`inbox/`)
  until the app has saved them, then they are deleted there.
- **Restarting:** `--new-code` issues a new pairing code; `--port` changes the
  port (default 8794).

**Limits**
- Logging in with OAuth / "Sign in with Microsoft/Google" is not supported.
  Use an app password, or ask your administrator for SMTP/IMAP access.
- The mailbox is checked only while the helper is running.
- If a check fails, the **Mail** badge turns red. Hover over it to see the
  error.

## Data privacy

- Files are read by the browser on your computer. The page's
  Content-Security-Policy allows it to talk only to the mail helper on the
  same computer (`127.0.0.1`) and blocks every other network request. The
  end-to-end tests check this.
- With the mail helper, notices and FIR copies leave the computer only as
  e-mails sent through **your own mail server** to the nodal officers. Replies
  are read from your own mailbox. No other server is involved.
- **Case data is stored in this browser's IndexedDB, on this computer only.**
  That covers the NCRP rows, FIR copy, notices and replies. Anyone who can use
  this Windows/browser profile can open them, so use the tool only on an
  official machine with a locked user account.
- **Delete this case** removes a case and its files. Clearing the browser's
  site data removes everything, so take regular **Backups**.
- Backup files (`*.bnss94.json`) contain full case data. Store them like any
  other case record.
- If the browser does not allow storage (for example some private windows), a
  **Not saving — memory only** badge appears. Data is then lost when the tab
  closes unless you take a backup.
- `localStorage` keeps officer details, column mappings, templates and
  bank-name fixes.
- **Never commit real data to this repository.** `.gitignore` blocks
  spreadsheets, Word/PDF/ZIP files, `.eml`, backups, `output/` and `data/`.
  Only the synthetic files in `samples/` are allowed.
- Always check each generated notice before you send it.

## Editing the templates

Click **Templates**. There are three templates, all plain text:

- the **notice** (`.docx`);
- the **e-mail subject**: keep `{{notice_ref}}` in it so replies can be
  matched;
- the **e-mail body**.

| Markup | Effect |
|--------|--------|
| one line | one paragraph (blank line = empty paragraph) |
| `[center]` / `[right]` at the start of a line | centre or right-align that line |
| `**text**` / `__text__` | bold / underline |
| `{{accounts_table}}` on its own line | the table(s) of accounts and/or identifiers for that recipient |
| `{{requested_items}}` on its own line | numbered list of the documents requested |

Placeholders (click one to insert it at the cursor):

| Placeholder | Value |
|-------------|-------|
| `{{date}}`, `{{reply_by}}` | notice date, and the date the reply is due |
| `{{notice_ref}}` | unique notice reference (e.g. `N94-123.2026-04`) |
| `{{bank_name}}` | recipient name as written in the nodal sheet |
| `{{fir_no}}`, `{{fir_date}}`, `{{police_station}}`, `{{sections}}` | FIR details |
| `{{ack_numbers}}` | NCRP Ack numbers covering that recipient |
| `{{items_description}}` | e.g. "2 accounts maintained with your bank …" or "4 mobile numbers serviced by your network" |
| `{{requested_list}}` | the requested documents on one line (for the subject) |
| `{{period}}` | records period from the FIR details |
| `{{item_count}}`, `{{total_disputed}}`, `{{total_loss}}`, `{{hold_amount}}` | counts and amounts |
| `{{officer_name}}`, `{{designation}}`, `{{station}}`, `{{phone}}`, `{{officer_email}}` | from Officer settings |
| `{{nodal_officer}}`, `{{bank_address}}` | from the nodal sheet, if those columns exist |

**Save templates** keeps your version in this browser. **Export .txt** and
**Import .txt** let you share it with colleagues. **Restore defaults** brings
back the built-in text. **Preview notice** shows the result, including the
e-mail.

## Nodal officers sheet format

Any layout with a header row works. The tool looks for columns like these:

| Bank Name | Category | IFSC Prefix | Domains / UPI Handles | Nodal Officer | Email ID | Alternate Email | Address |
|---|---|---|---|---|---|---|---|
| State Bank of India | Bank | SBIN | | … | … | | |
| Some Telecom Ltd | Telecom | | | … | … | | |
| Some Social Network | Social media platform | | example.com, ex.am | … | … | | |
| Some Payments Bank | Payment / Wallet | ABCD | okabcd, abcdpay.com | … | … | | |

- **Bank Name** and at least one **e-mail** column are required. A cell may
  hold several e-mails separated by `;` or `,`.
- **Category**:
  - text containing *telecom / TSP / mobile* → Telecom;
  - *wallet / payment / UPI* → Payment;
  - *social / platform / app / website / e-mail* → Platform;
  - anything else, or blank → Bank.
- **Domains / UPI Handles** are used to match URLs, e-mail IDs and UPI IDs
  (`name@okabcd` → handle `okabcd`). Sub-domains match too.
- Rows with the same name are merged.

## Development and tests

```bash
node tests/run-tests.js      # logic on the samples, incl. .eml round-trips (no install needed)
```

```bash
node tests/mail-helper-tests.js   # mail helper against mock SMTP/IMAP servers (TLS tests need openssl)
```

```bash
node tests/e2e.js            # drives index.html in headless Chromium (needs Playwright)
```

```bash
node tests/e2e-mail.js       # app + mail helper + mock mail servers: send all, automatic reply pick-up
```

```bash
node tools/make-samples.js   # regenerate the synthetic samples
```

Code layout (plain scripts, no build step; the pure modules also load in Node):

- `js/analysis.js`: column guessing, normalisation, Layer 1 / per-Ack totals,
  identifier extraction, bank and domain matching, mandatory-field checks
- `js/template.js`: default notice and e-mail text, request catalogue, template
  parser
- `js/mail.js`: `.eml` draft builder, reply parser, reply-to-notice matching
- `js/outputs.js`: `.docx`, `.xlsx`, `.eml` and ZIP builders
- `js/store.js`: IndexedDB case store and backup/restore
- `js/app.js`: UI
- `mail-helper/`: optional local mail helper (`server.js` API, `smtp.js`,
  `imap.js`, launchers)
- `samples/`: synthetic NCRP export (39 rows, 8 Ack nos, 3 layers, suspect
  identifiers, put-on-hold amounts), nodal sheet and FIR copy. All names,
  numbers and e-mails are invented.

## Licence

MIT for this tool. Vendored libraries keep their own licences (see
`vendor/licenses/`).
