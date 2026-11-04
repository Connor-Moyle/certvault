# CertVault

Self-hosted vault for **everything that expires or needs renewing**. It runs on your NAS and covers licences, tickets, certificates, site inductions, equipment registers, insurance, vehicle rego and servicing, business documents, ID, warranties, calibrations, memberships and work medicals.
Upload a photo or PDF. **AI reads the file and fills in the details**: type, who issued it, holder, number, completion date, expiry date and location. You get **phone notifications 30, 14 and 7 days before expiry and on the day** (you can change these).

<p>
<img src="docs/home-light.png" width="200"> <img src="docs/home-dark.png" width="200"> <img src="docs/document.png" width="200"> <img src="docs/add.png" width="200">
</p>

## Features

- **Any file, any size, nothing skipped.**
  - Photos (JPG/PNG/HEIC/WEBP/GIF/BMP), PDFs of any size (default limit 1 GB, `CV_MAX_UPLOAD_MB` to change), multi-page TIFF scans (turned into a PDF), Word (DOCX/ODT), Excel (XLSX/XLS/CSV), emails (EML), text, and **ZIPs, which are unpacked with every file inside imported**.
  - Anything else (video, CAD, …) is still stored as a document for you to fill in.
  - Uploads stream to disk with live MB progress. Only system junk like `.DS_Store` / `Thumbs.db` is ignored.
- **File naming / renaming.** In *Settings → File naming* you pick the parts and their order: holder name, ticket/licence type, classes (CV DG RB), number, issuer, expiry, completed date, year, status. You also choose the separator, date style and letter case, with a live preview.
  - This naming is used for every download, email attachment, ZIP and phone share.
  - It can also rename document titles, for new uploads or all at once.
- **Auto-named library on the NAS.** `/mnt/CME_Nas/certvault/library/<you>/<Group>/<Type>/` holds every file under your naming scheme, kept in sync automatically. These are hard links, so no extra space is used. Share that folder over SMB to browse it from Windows.
- **Upload from your phone.** Take a photo with the camera or pick any files.
- **Import a whole folder.** Tap **Import folder** (or drag a folder onto the page on a PC). Every PDF, photo and register spreadsheet inside, including sub-folders, is uploaded in batches. Duplicates are skipped and non-cert files ignored.
- **Registers.** Rigging gear, height safety gear, test & tag, plant/equipment and other registers, as PDF, photo or **Excel/CSV**. The last inspection date and the earliest *next inspection due* date are pulled out, and reminders say "inspection due" instead of "expires".
- **Renewals / previous versions.** Upload a renewed ticket and it's grouped with the older copies of the same cert. Only the newest sends reminders. The ⋮ menu on a document shows **Previous / expired versions**, and you can mark one *Not a renewal — keep separate*.
- **Everything becomes a searchable PDF.**
  - Every document gets one combined PDF of all its sides and pages: photos and scans get an invisible OCR text layer, and Word/Excel/PowerPoint/text/emails are converted with LibreOffice.
  - Your originals are always kept too.
  - Sharing, email, ZIP packs and the NAS library use the PDF by default, so the person you send it to can open it on anything. You can switch to originals in *Settings → File naming*.
  - **One PDF ticket pack:** a cover page summary table, then every selected document, in one file. It's on the share sheet and in each folder.
- **Folders: organisations & groups.**
  - *Western Power, South32, Telstra, BHP, Rio Tinto, Alcoa, Woodside, NBN, Amplitel, Indara, FEC…* folders are created and filled automatically when a document mentions them.
  - *Medicals* and *Government docs* are filled automatically too, and you can make your own.
  - Give a folder the tickets that client requires and it shows a **ready / expiring / missing checklist** (e.g. "Western Power: 4 of 7 ready, rescue missing"). One tap sends everything they need.
  - The NAS library also has a `By folder` view.
- **More than certs.** Document types are grouped into *Tickets & licences*, *Registers*, *Insurance* (public liability / certificate of currency, workers comp, income protection, PI, vehicle, tools, home), *Vehicles* (rego, servicing, inspections), *Business* (ABN, contracts, client/supplier onboarding, SWMS), *Personal ID* (passport, other ID), *Warranties & equipment* (warranties, receipts, calibration certs, fire extinguisher service, memberships) and *Work medicals*. Labels change to suit each one, e.g. *Insurer / Policy number / Renewal date*.
- **Add without a file.** Track a service, subscription, BAS or anything with a date. Attach a file later if you want.
- **Mark renewed / done.** One tap rolls the due date forward by its renewal period (e.g. rego +12 months, service +6). It counts from the old due date, so you don't lose days.
- **Front & back / multi-page.** Turn on *Front & back of one card* and take the front, then the back. Or add a back/extra page to any document later. The AI and OCR read every side.
- **Licence classes decoded.** HRWL classes are picked up and spelled out (e.g. **CV – Vehicle loading crane**, DG – Dogging, RB – Basic rigging, WP – Boom-type EWP). WA driver's licence classes (C, LR, MR, HR, HC, MC, R) work the same way. You can also type just the codes when editing and they're expanded for you.
- **More detail per document:** classes/endorsements, RTO code, *required for* (clients/sites), how to renew, cost, tags.
- **Share / send to someone.** Use the share button on any document, select several in *Documents*, or send everything current from the home screen or the master list:
  - **Email it.** Sent straight from CertVault with every side attached, an optional summary spreadsheet, and your name/phone as the signature and reply-to.
  - **Phone apps.** The Android share sheet (WhatsApp, Gmail, Messages…) with the actual files. This needs HTTPS, see *Access away from home*.
  - **Ticket pack.** A ZIP of all the files sorted by type, plus a summary and a spreadsheet.
  - **Copy details.** Text you can paste anywhere.
  - Every share is logged on the document ("Shared with …").
- **Add to calendar.** A `.ics` file per document or for all expiries, with alarms that match your reminder days.
- **Cleaner scanned text.** Photos are straightened, shadows are removed, upside-down/sideways shots are detected and junk is filtered out. With AI on you get a clean transcript as well.
- **Activity log.** Logins (including failed ones), uploads, edits, shares and settings changes.
- **Master list.** One text-only list of every document with every field. It's on the *Master list* tab (filter, print, tap a row to open it) and downloads as Excel or CSV. An always-current copy is also saved on the NAS at `/mnt/CME_Nas/certvault/exports/<you> - CertVault Master List.xlsx` (and `.csv`).
- **AI autofill.** Claude (Anthropic API) or your own **Ollama** vision model looks at every file. OCR text is also sent to help it.
  - Without AI it still works: Tesseract OCR and Australian/WA-specific rules pick out dates, unit codes, RTOs and issuers.
  - **Re-read all documents** runs every stored file through the AI again and fills in any blank fields.
- **Auto-categorised.** Types it recognises: Driver's licence, HRWL, rigging/dogging, white card, first aid, CPR, heights, rescue (tower/pole/LV), confined space, gas test, EWP, RF/EME, traffic, electrical/cabling, police clearance, WWC, MSIC/ASIC, site inductions and other training. Issuers are grouped as government (WA DoT, WorkSafe, …), training provider (RTO) or company/site.
- **Expiry estimates.** If a card has no printed expiry, CertVault estimates one from typical validity (first aid 3 yrs, CPR 1 yr, heights 2 yrs …) and flags it as *estimated*.
- **Reminders.** Default schedule is 30/14/7/0 days. You can override it per document (e.g. 60,30,7,0). Weekly nags after expiry are optional. If the NAS was off on a reminder day, it catches up without spamming you.
- **Notification channels:**
  - [ntfy](https://ntfy.sh) push to Android
  - Email (SMTP, e.g. a Gmail app password)
  - Home Assistant webhook, which can forward to the HA companion app
- **Android look and feel.** Material You (Material 3) design with Material Symbols Rounded icons, a bottom navigation bar, a FAB, and light/dark themes with 5 accent colours. You can install it to the home screen as a PWA.
- **Security:**
  - argon2id password hashing, plus optional 2-step login (TOTP: Google Authenticator, Aegis…)
  - HttpOnly + SameSite=Strict session cookies and CSRF tokens
  - Brute-force lockout: 5 failed attempts per user, or 20 per IP, locks for 15 minutes
  - Strict Content-Security-Policy and other security headers
  - Uploads are checked by file signature, re-encoded to strip EXIF/GPS, stored under random names and only served to their owner
  - The container runs as non-root (UID 568) with a read-only filesystem, no capabilities and no-new-privileges
- **Multi-user.** You can add family or crew members, and each person only sees their own documents.

## Install on TrueNAS SCALE (25.x)

**Quickest:** open **System → Shell** in TrueNAS and paste:
```bash
curl -fsSL https://raw.githubusercontent.com/Connor-Moyle/certvault/main/install-truenas.sh | sudo bash
```
It creates the `CME_Nas/certvault` dataset, installs the app on port 30090 and prints your setup code.

**Manual:**

1. **Create a dataset** for the data, e.g. `CME_Nas/certvault`. Give the `apps` user (568) full control.
   From a shell:
   ```bash
   sudo mkdir -p /mnt/CME_Nas/certvault && sudo chown 568:568 /mnt/CME_Nas/certvault
   ```
2. **Apps → Discover Apps → ⋮ (top right) → Install via YAML.** Name it `certvault` and paste [`docker-compose.yml`](docker-compose.yml).
3. Open the app's **Logs** and copy the **setup code**. It's also saved in `/mnt/CME_Nas/certvault/SETUP_CODE.txt`.
4. Browse to **http://192.168.0.50:30090**, enter the setup code and create your account.

> **Image pull denied?** GitHub sometimes publishes new packages as private. Go to GitHub → your profile → *Packages* → `certvault` → *Package settings* → **Change visibility → Public**.
> Or build on the NAS instead:
> ```bash
> git clone https://github.com/Connor-Moyle/certvault.git && cd certvault
> sudo docker compose -f docker-compose.build.yml up -d --build
> ```

### Updating
TrueNAS: **Apps → certvault → Update** (or *Edit → Save* to re-pull `:latest`). Your data in the dataset is kept.

## Android app

Get it from **[Releases → CertVault.apk](https://github.com/Connor-Moyle/certvault/releases/latest/download/CertVault.apk)**. Open that link on your phone, then tap *Install*. The first time, allow "install unknown apps" for your browser. Every push to `android/` builds a new APK automatically.

When you first open it, enter your server address, e.g. `http://192.168.0.50:30090` (or your Tailscale address). What the app adds over the browser:

- **Real share sheet**: WhatsApp, Gmail, Messages and so on get the actual PDF files. This works over plain HTTP, no HTTPS needed.
- **"Save to CertVault"** appears in every app's share menu (Gmail attachments, Files, Photos, Drive…) and uploads straight in.
- **Camera and file picking** for uploads, PDFs open in your PDF viewer, and downloads are saved to `Downloads/CertVault`.
- **Reminders on the phone itself.** It checks twice a day and shows one notification when something is expired or due within 30 days. ntfy and email still work too.
- A themed icon that matches Material You.

**Signing:** app updates only install over the top if every build is signed with the same key. Add your key once as repository secrets (*Settings → Secrets and variables → Actions*): `CV_KEYSTORE_B64` (the keystore, base64-encoded), `CV_KEYSTORE_PASS` and `CV_KEY_ALIAS`. Until you do, each build uses a throwaway key, and you'll need to uninstall before installing a newer build. Keys are never stored in this repository.

## Set up AI autofill

**Settings → AI document reading** (admin only):

| Option | What you need | Notes |
|---|---|---|
| **Claude** | API key from [console.anthropic.com](https://console.anthropic.com) | Most accurate; reads PDFs natively. About a cent or two per document. Default model `claude-sonnet-5-5`. |
| **Ollama (local)** | Ollama reachable from the NAS + a **vision** model | Free and private. Run it on the desktop GPU for speed: `ollama pull qwen2.5vl:7b`. Set Ollama to listen on the LAN (`OLLAMA_HOST=0.0.0.0`) and use `http://<desktop-ip>:11434`. The NAS (8 GB RAM, no GPU) will be very slow with vision models. |
| **Off** | – | OCR + rules only. |

Press **Test**, then **Re-read all documents** to run the AI over everything already uploaded.

## Notifications on Android (ntfy)

1. Install **ntfy** from the Play Store.
2. In CertVault go to **Settings → Notifications → Make a private topic → Save**.
3. In the ntfy app tap **+**, subscribe to the same topic name (e.g. `certvault-k3j9…`), then press **Send test** in CertVault.

The topic name works like a password, so keep it random. If you'd rather self-host ntfy on the NAS, put your own server URL in instead.

Reminders go out once a day at the time you set (default 8 am Perth). **Check now** runs the check straight away.

## Access away from home

Don't port-forward it. Tailscale is already on the NAS, so open `http://<nas-tailscale-name>:30090` from your phone on Tailscale.
For HTTPS (needed for the "Install app" prompt and offline shell), use `tailscale serve --bg 30090` on the NAS and set `CV_COOKIE_SECURE: "true"`.

## Backup

Everything is in the dataset: `certvault.db` (SQLite) plus the `files/` and `thumbs/` folders. Include that dataset in your snapshot/replication tasks.
Tip: enable **dataset encryption** on `certvault` in TrueNAS if you want encryption at rest.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `TZ` | `Australia/Perth` | Timezone for reminder days |
| `CV_DATA_DIR` | `/data` | Where DB and files live |
| `CV_MAX_UPLOAD_MB` | `1024` | Max size per file (MB) |
| `CV_SESSION_DAYS` | `30` | Idle days before re-login |
| `CV_COOKIE_SECURE` | `auto` | `true` when served only over HTTPS |

To add your own categories, edit `app/categories.py`. The UI and the AI prompt pick them up automatically.

## Development

```bash
pip install -r requirements.txt pytest
sudo apt install tesseract-ocr poppler-utils   # OCR + PDF tools
CV_DATA_DIR=./data uvicorn app.main:app --reload --port 8080
pytest -q tests
```

Stack: FastAPI · SQLite · Tesseract · Poppler · vanilla JS (no build step) · Material Symbols (Apache-2.0).
Icon sprite: `npm i @material-symbols/svg-400 && python tools/build_icons.py node_modules/@material-symbols/svg-400/rounded`.

## License
MIT
