# CertVault changelog

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
