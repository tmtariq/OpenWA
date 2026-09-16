# Contacts Section & CSV Import Design Specification

**Date**: 2026-09-16  
**Status**: Approved  
**Topic**: Contacts Section and CSV Import Wizard in Dashboard  

---

## 1. Overview & Goals

OpenWA supports managing session contacts on WhatsApp via the gateway API (`GET /sessions/:sessionId/contacts`, `PUT /sessions/:sessionId/contacts/:contactId`, and `GET /sessions/:sessionId/contacts/check/:number`), but the web dashboard lacked a dedicated interface for browsing contacts and bulk-importing contacts from CSV files.

This specification introduces:
1. A dedicated **Contacts** page (`/contacts`) in the dashboard with session selection, contact browsing, filtering, and direct links to start chats.
2. A multi-step **CSV Import Wizard** that allows operators to upload contacts in `.csv` format, auto-detect or manually map columns (Phone, First Name, Last Name), preview data, throttle API requests to avoid rate limits, and view detailed success/failure reports with error export.

---

## 2. Architecture & Approach

### 2.1 Approach Selection: Client-Side Orchestrated Import
- **Client-Driven Import**: Leverages the existing REST endpoints (`contactApi.list`, `contactApi.upsertContact`, and `contactApi.checkNumber`) using a client-side controlled concurrency worker queue.
- **Benefits**:
  - No disruptive schema changes or backend queue dependencies.
  - Granular real-time UI feedback (row-by-row status, progress bar, pause/resume/cancel).
  - Built-in error export allowing instant correction of failed records.

---

## 3. Detailed Component & UI Design

### 3.1 Routing & Navigation
- **Route**: Add route `/contacts` to [`dashboard/src/App.tsx`](file:///Users/tmtar/Documents/DigitalSofts/open-wa/OpenWA/dashboard/src/App.tsx).
- **Sidebar**: Insert `Contacts` navigation item in [`dashboard/src/components/Layout.tsx`](file:///Users/tmtar/Documents/DigitalSofts/open-wa/OpenWA/dashboard/src/components/Layout.tsx) positioned immediately after `Chats`.
  - Icon: `ContactRound` from `lucide-react`.
  - Localization: `nav.contacts` in i18n locale files.

### 3.2 Contacts Page (`dashboard/src/pages/Contacts.tsx`)
- **Header**:
  - Session selector dropdown (selects the active WhatsApp session).
  - Summary stats: Total contacts, In-Addressbook (`isMyContact`), Blocked (`isBlocked`).
  - Search input: Real-time search by contact name, phone number, or JID.
  - Actions: **"Import CSV"** primary button and **"Refresh"** button.
- **Contact Table**:
  - Avatar thumbnail with fallback initials.
  - Name (display name or pushName).
  - Phone / WhatsApp JID.
  - Status badges (`In Addressbook`, `Blocked`).
  - Actions:
    - Open chat in `/chats?session={id}&chatId={jid}`.
    - Quick edit name (triggers `PUT /sessions/:sessionId/contacts/:contactId`).
    - Block / Unblock contact.

### 3.3 CSV Import Wizard (`dashboard/src/components/ContactCsvImportModal.tsx`)
A 4-step modal wizard:
1. **Upload Step**:
   - Drag & drop or file browse input supporting `.csv`.
   - File size guard: capped at 5MB.
   - Robust CSV parser handling CRLF/LF/CR line breaks and comma/semicolon/tab delimiters with quote escaping and formula injection sanitization.
2. **Column Mapping Step**:
   - Auto-detection heuristics:
     - *Phone*: matches headers `phone`, `mobile`, `tel`, `whatsapp`, `number`, `msisdn`, or samples first rows for 6+ digits.
     - *First Name*: matches `first_name`, `firstname`, `first`, `name`.
     - *Last Name*: matches `last_name`, `lastname`, `last`, `surname`.
   - Manual dropdown selectors to re-assign headers.
   - Toggle: "Single Name Column" option to auto-split "First Last" on the first whitespace.
   - Options:
     - `validateOnWhatsApp` (boolean, default `false`): Checks number registration on WhatsApp before saving.
     - `skipExisting` (boolean, default `false`): Skips contacts that are already saved in the addressbook (`isMyContact`).
3. **Preview Step**:
   - Preview first 5 parsed records with computed normalized phone number and names.
   - Summarizes total rows detected, valid rows, and invalid rows (e.g. phone numbers < 6 digits).
4. **Execution & Report Step**:
   - Live progress bar showing percentage, processed count vs total, and processing status.
   - Worker queue with concurrency of 3 workers and 50ms inter-request delay.
   - Controls: Pause, Resume, Cancel.
   - Outcome report: Total Processed, Successes, Skipped, Errors.
   - Table of failed rows detailing original CSV row number, phone, and error reason.
   - "Download Failed Rows as CSV" button.
   - On completion: Invalidate and refresh contact list in the dashboard.

---

## 4. Error Handling & Edge Cases

- **Rate Limits & Throttling**: WhatsApp sessions can throttle rapid addressbook updates. The import queue processes up to 3 concurrent requests with a 50ms stagger.
- **Formula Injection Defense**: Any cell starting with `=, +, -, @` is sanitized to prevent spreadsheet formula execution when exporting error CSVs.
- **Session Disconnect**: If the WhatsApp session drops during import, the queue catches the 400/409/503 error, records the error on the specific row, and allows the operator to pause or cancel.
- **Invalid Phone Formats**: Strips extraneous characters (spaces, parentheses, dashes, plus sign). Rejects entries with fewer than 6 digits.

---

## 5. Testing Plan

1. **Unit Tests**:
   - CSV Parser (`dashboard/src/utils/contactCsv.test.ts`): Tests varied delimiters, quotes, newlines, and formula escaping.
   - Column Auto-Detection: Verifies recognition of different common CSV header aliases.
   - Phone Normalizer: Tests international formats, bare digits, and invalid values.
2. **Component Tests**:
   - `Contacts.test.ts`: Verifies rendering, search filtering, empty states, and action triggers.
   - `ContactCsvImportModal.test.ts`: Verifies CSV parsing, mapping changes, and completion callback.
