# CertVault changelog

## 1.8 — security & reliability (independent review)
- NAS library files are now **independent copies**, not hard links, so editing or deleting them over SMB can never damage the originals. Each user gets their own folder.
- Version grouping is stricter: unrelated uploads (e.g. two `image.jpg` photos) are no longer merged or hidden, and the newest *issued* copy wins.
- **Android app pins your server:** it won't load the page or send your login to a different device at the same address (e.g. on someone else's Wi-Fi).
  - Sharing only fetches from your own server.
  - Temp files are cleaned up.
- ZIP imports share one 8 GB / 2000-file budget across nested ZIPs, with a zip-bomb check on every file. Huge TIFF scans are converted page by page.
- Deleting a user also deletes their PDFs, library folder and master list.
- The login lockout can't be dodged with spaces or capitals in the username.
- The pre-restore safety copy includes the latest changes, and restarts work under any restart policy.
- Downloads with non-English characters in names work (e.g. "Tāne").
- LibreOffice conversions can't clash, Tesseract has timeouts so a bad file can't stall the queue, adding a page to a confirmed document keeps it confirmed, and folder icons are validated.

## 1.7 — search, timeline, backups
- **Search inside documents.** Search matches the text of every side (OCR/AI), not just titles, and shows a snippet.
- **Timeline:** 12 months of what's due, a bar chart per month, and estimated renewal costs.
- **Weekly summary** push/email on Monday mornings.
- **Nightly database backup** to `backups/` (14 kept), a **full backup download**, and **restore** (the app restarts itself to apply it).
- Renewals with the same licence/cert number are grouped as versions, even if the titles differ.

## Android app
- Download **CertVault.apk** from GitHub *Releases*. It's built automatically on every change.
- Native share sheet with the real PDFs (works over plain HTTP).
- **Save to CertVault** in every app's share menu.
- Camera/file upload, PDFs open in your viewer, and downloads go to `Downloads/CertVault`.
- On-phone reminders twice a day, and a Material You themed icon.

## 1.6 — PDF everything, folders
- Every document gets **one searchable PDF** with all sides. Photos get an OCR text layer, and Office docs and emails go through LibreOffice. Originals are kept.
- Sharing, email, ZIPs and the NAS library default to PDF. **One-PDF ticket pack:** a cover summary plus every document.
- **Folders:** organisations (Western Power, South32, Telstra, BHP, Rio, Alcoa, Woodside, NBN, Amplitel, Indara, FEC…), *Medicals* and *Government docs*, all auto-filed. You can add your own.
- **Per-folder requirements checklist:** ready / expiring / missing, plus a "send what they need" button.

## 1.5 — accept everything, file naming
- Any file type and size (1 GB default) is accepted. **ZIPs are unpacked**, TIFF scans become PDFs, Word/Excel/emails/text are read, and unknown types are stored rather than skipped.
- Uploads stream to disk with live MB progress.
- **File naming scheme** in Settings (holder, type, classes, expiry…), used everywhere, with an optional title rename.
- **Auto-named library** folder on the NAS.
- OCR fixes: sparse pages, unit codes, punctuation.

## 1.4 — beyond certs
- Insurance, vehicles (rego/service/inspection), business (ABN, contracts, onboarding, SWMS), ID, warranties/receipts/calibrations, memberships and work medicals.
- **Add without a file**, and **Mark renewed / done** to roll a due date forward.

## 1.3 — front & back, sharing, classes
- Front & back / multi-page documents.
- **HRWL and driver's licence classes** detected and spelled out.
- Share: email with attachments, phone share sheet, ZIP, copy details; history of every share.
- New fields: classes, RTO, required for, how to renew, cost, tags.
- OCR overhaul: deskew, shadow removal, orientation detection, junk filtering, plus an AI transcript.
- Calendar export, activity log and compliance score.

## 1.2 — folders of files, registers, master list
- Folder import, and rigging/height/test-and-tag/plant registers (including Excel/CSV).
- **Master list** of every field (Excel/CSV, auto-saved on the NAS).
- **Previous / expired versions** under the ⋮ menu.

## 1.0 / 1.1 — first release
- Upload, OCR + AI autofill (Claude or Ollama), Material You mobile UI.
- Login with 2-step verification.
- Reminders at 30/14/7/0 days via ntfy/email/Home Assistant.
- One-command TrueNAS installer.
