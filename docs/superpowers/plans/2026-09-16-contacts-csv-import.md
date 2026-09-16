# Contacts Section & CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated Contacts section in the OpenWA web dashboard with live session contacts browsing and a multi-step CSV import wizard to bulk-import contacts into WhatsApp with controlled throttling and error reporting.

**Architecture:** Client-side orchestrated import utilizing OpenWA's existing REST API (`/sessions/:sessionId/contacts` and `/sessions/:sessionId/contacts/:contactId`). A dedicated `/contacts` page provides session filtering, search, and addressbook status; the CSV import wizard handles in-browser file parsing, column auto-detection/mapping, phone normalization, concurrency-controlled upserts (3 workers, 50ms delay), live progress feedback, and error CSV downloads.

**Tech Stack:** React 19, TypeScript 6, Vite, `@tanstack/react-query`, `lucide-react`, `react-i18next`, Node test runner (`node --experimental-strip-types --test`).

## Global Constraints

- Never break existing dashboard tests or i18n parity (`npm test`, `npm run typecheck`, and `npm run i18n:check` must pass).
- Sanitize CSV outputs against formula injection (`=`, `+`, `-`, `@` prefixing with `'`).
- Minimum phone digits bound is 6 digits (`MIN_PHONE_DIGITS = 6`), normalized to `<digits>@c.us`.
- Throttled concurrency must cap at 3 simultaneous requests with 50ms stagger to prevent WhatsApp engine/puppeteer timeouts.

---

### Task 1: Contact CSV Parsing & Normalization Utilities

**Files:**
- Create: `dashboard/src/utils/contactCsv.ts`
- Test: `dashboard/src/utils/contactCsv.test.ts`

**Interfaces:**
- Consumes: Standard JS strings and File API.
- Produces:
  ```typescript
  export interface ParsedCsv {
    headers: string[];
    rows: string[][];
  }

  export interface ColumnMapping {
    phoneIndex: number;
    firstNameIndex: number;
    lastNameIndex: number;
    hasSingleNameColumn: boolean;
  }

  export interface NormalizedContactCandidate {
    rowIndex: number;
    rawPhone: string;
    normalizedPhone: string;
    jid: string;
    firstName: string;
    lastName?: string;
    isValid: boolean;
    invalidReason?: string;
  }

  export function parseContactCsv(content: string): ParsedCsv;
  export function detectContactColumns(headers: string[], rows?: string[][]): ColumnMapping;
  export function normalizePhoneNumber(raw: string): { phone: string; jid: string; isValid: boolean };
  export function splitFullName(fullName: string): { firstName: string; lastName?: string };
  export function mapRowsToCandidates(rows: string[][], mapping: ColumnMapping): NormalizedContactCandidate[];
  export function exportFailedRowsToCsv(failures: { rowNumber: number; phone: string; name: string; error: string }[]): string;
  ```

- [ ] **Step 1: Write unit tests for CSV parsing, column detection, and normalization**

Create `dashboard/src/utils/contactCsv.test.ts`:
```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContactCsv,
  detectContactColumns,
  normalizePhoneNumber,
  splitFullName,
  mapRowsToCandidates,
  exportFailedRowsToCsv,
} from './contactCsv';

describe('contactCsv', () => {
  it('parses standard comma-separated CSV with quotes and varying line endings', () => {
    const csv = 'Name,Phone,Notes\r\n"Alice Smith",+1 (555) 234-5678,"Friend, VIP"\nBob,+44 7700 900077,Work\r';
    const result = parseContactCsv(csv);
    assert.deepEqual(result.headers, ['Name', 'Phone', 'Notes']);
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows[0], ['Alice Smith', '+1 (555) 234-5678', 'Friend, VIP']);
    assert.deepEqual(result.rows[1], ['Bob', '+44 7700 900077', 'Work']);
  });

  it('detects semicolon and tab separated CSVs', () => {
    const semicolonCsv = 'First Name;Last Name;Mobile\nJohn;Doe;1234567890';
    const parsed = parseContactCsv(semicolonCsv);
    assert.deepEqual(parsed.headers, ['First Name', 'Last Name', 'Mobile']);
    assert.equal(parsed.rows.length, 1);

    const mapping = detectContactColumns(parsed.headers, parsed.rows);
    assert.equal(mapping.phoneIndex, 2);
    assert.equal(mapping.firstNameIndex, 0);
    assert.equal(mapping.lastNameIndex, 1);
  });

  it('normalizes international phone numbers and flags invalid ones', () => {
    const valid1 = normalizePhoneNumber('+1 (555) 234-5678');
    assert.equal(valid1.isValid, true);
    assert.equal(valid1.phone, '15552345678');
    assert.equal(valid1.jid, '15552345678@c.us');

    const valid2 = normalizePhoneNumber('628123456789@c.us');
    assert.equal(valid2.isValid, true);
    assert.equal(valid2.phone, '628123456789');
    assert.equal(valid2.jid, '628123456789@c.us');

    const invalidShort = normalizePhoneNumber('12345');
    assert.equal(invalidShort.isValid, false);

    const invalidEmpty = normalizePhoneNumber('');
    assert.equal(invalidEmpty.isValid, false);
  });

  it('splits full names into first and last name', () => {
    assert.deepEqual(splitFullName('John Doe'), { firstName: 'John', lastName: 'Doe' });
    assert.deepEqual(splitFullName('Madonna'), { firstName: 'Madonna', lastName: undefined });
    assert.deepEqual(splitFullName('Mary Jane Watson'), { firstName: 'Mary', lastName: 'Jane Watson' });
  });

  it('exports failed rows to CSV with formula-injection sanitization', () => {
    const failures = [
      { rowNumber: 2, phone: '12345', name: '=CMD|calc', error: 'Invalid phone' },
    ];
    const exported = exportFailedRowsToCsv(failures);
    assert.match(exported, /"Row","Phone","Name","Error"/);
    assert.match(exported, /"'=CMD\|calc"/); // formula sanitized
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test "src/utils/contactCsv.test.ts"` inside `dashboard/`
Expected: FAIL with module not found or functions undefined.

- [ ] **Step 3: Implement `contactCsv.ts`**

Create `dashboard/src/utils/contactCsv.ts`:
```typescript
import { escapeCsvCell } from './csv';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export interface ColumnMapping {
  phoneIndex: number;
  firstNameIndex: number;
  lastNameIndex: number;
  hasSingleNameColumn: boolean;
}

export interface NormalizedContactCandidate {
  rowIndex: number;
  rawPhone: string;
  normalizedPhone: string;
  jid: string;
  firstName: string;
  lastName?: string;
  isValid: boolean;
  invalidReason?: string;
}

export const MIN_PHONE_DIGITS = 6;

/**
 * Parses raw CSV text handling quotes, embedded commas/newlines, and varying linebreaks.
 */
export function parseContactCsv(content: string): ParsedCsv {
  if (!content || !content.trim()) {
    return { headers: [], rows: [] };
  }

  // Determine delimiter: inspect first non-empty line
  const firstLine = content.split(/\r\n?|\n/)[0] || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;

  let delimiter = ',';
  if (semicolonCount > commaCount && semicolonCount > tabCount) delimiter = ';';
  else if (tabCount > commaCount && tabCount > semicolonCount) delimiter = '\t';

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentField += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\r') {
        if (nextChar === '\n') i++;
        currentRow.push(currentField.trim());
        if (currentRow.some(cell => cell.length > 0)) rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else if (char === '\n') {
        currentRow.push(currentField.trim());
        if (currentRow.some(cell => cell.length > 0)) rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(cell => cell.length > 0)) rows.push(currentRow);
  }

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map(h => h.replace(/^["']|["']$/g, '').trim());
  const dataRows = rows.slice(1);

  return { headers, rows: dataRows };
}

export function detectContactColumns(headers: string[], rows: string[][] = []): ColumnMapping {
  let phoneIndex = -1;
  let firstNameIndex = -1;
  let lastNameIndex = -1;
  let hasSingleNameColumn = false;

  const cleanHeaders = headers.map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));

  // 1. Phone match
  const phonePatterns = ['phone', 'mobile', 'tel', 'whatsapp', 'cell', 'number', 'msisdn', 'contact'];
  for (let i = 0; i < cleanHeaders.length; i++) {
    if (phonePatterns.some(p => cleanHeaders[i].includes(p))) {
      phoneIndex = i;
      break;
    }
  }

  // Fallback for phone: scan first row values for digit count
  if (phoneIndex === -1 && rows.length > 0) {
    for (let c = 0; c < headers.length; c++) {
      const val = (rows[0][c] || '').replace(/[^0-9]/g, '');
      if (val.length >= MIN_PHONE_DIGITS) {
        phoneIndex = c;
        break;
      }
    }
  }

  // 2. First Name / Name match
  const firstNamePatterns = ['firstname', 'first', 'givenname', 'fname'];
  for (let i = 0; i < cleanHeaders.length; i++) {
    if (firstNamePatterns.some(p => cleanHeaders[i] === p || cleanHeaders[i].includes(p))) {
      firstNameIndex = i;
      break;
    }
  }

  // 3. Last Name match
  const lastNamePatterns = ['lastname', 'last', 'surname', 'familyname', 'lname'];
  for (let i = 0; i < cleanHeaders.length; i++) {
    if (lastNamePatterns.some(p => cleanHeaders[i] === p || cleanHeaders[i].includes(p))) {
      lastNameIndex = i;
      break;
    }
  }

  // 4. Single Name column fallback
  if (firstNameIndex === -1 && lastNameIndex === -1) {
    for (let i = 0; i < cleanHeaders.length; i++) {
      if (i !== phoneIndex && (cleanHeaders[i] === 'name' || cleanHeaders[i].includes('name'))) {
        firstNameIndex = i;
        hasSingleNameColumn = true;
        break;
      }
    }
  }

  return {
    phoneIndex: phoneIndex >= 0 ? phoneIndex : 0,
    firstNameIndex: firstNameIndex >= 0 ? firstNameIndex : (phoneIndex === 0 && headers.length > 1 ? 1 : 0),
    lastNameIndex,
    hasSingleNameColumn,
  };
}

export function normalizePhoneNumber(raw: string): { phone: string; jid: string; isValid: boolean } {
  if (!raw) return { phone: '', jid: '', isValid: false };

  let digits = raw.trim();
  if (digits.endsWith('@c.us')) {
    digits = digits.replace('@c.us', '');
  }
  digits = digits.replace(/[^0-9]/g, '');

  if (digits.length < MIN_PHONE_DIGITS) {
    return { phone: digits, jid: '', isValid: false };
  }

  return {
    phone: digits,
    jid: `${digits}@c.us`,
    isValid: true,
  };
}

export function splitFullName(fullName: string): { firstName: string; lastName?: string } {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return { firstName: '' };

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) {
    return { firstName: trimmed };
  }

  return {
    firstName: trimmed.slice(0, firstSpace).trim(),
    lastName: trimmed.slice(firstSpace + 1).trim() || undefined,
  };
}

export function mapRowsToCandidates(rows: string[][], mapping: ColumnMapping): NormalizedContactCandidate[] {
  return rows.map((row, idx) => {
    const rawPhone = row[mapping.phoneIndex] || '';
    const norm = normalizePhoneNumber(rawPhone);

    let firstName = '';
    let lastName: string | undefined;

    if (mapping.hasSingleNameColumn || mapping.lastNameIndex === -1) {
      const parsed = splitFullName(row[mapping.firstNameIndex] || '');
      firstName = parsed.firstName;
      lastName = parsed.lastName;
    } else {
      firstName = (row[mapping.firstNameIndex] || '').trim();
      lastName = (row[mapping.lastNameIndex] || '').trim() || undefined;
    }

    if (!firstName && norm.phone) {
      firstName = norm.phone;
    }

    const isValid = norm.isValid && firstName.length > 0;
    const invalidReason = !norm.isValid
      ? `Phone number too short or invalid (minimum ${MIN_PHONE_DIGITS} digits)`
      : undefined;

    return {
      rowIndex: idx + 2, // 1-based, header is row 1
      rawPhone,
      normalizedPhone: norm.phone,
      jid: norm.jid,
      firstName,
      lastName,
      isValid,
      invalidReason,
    };
  });
}

export function exportFailedRowsToCsv(
  failures: { rowNumber: number; phone: string; name: string; error: string }[],
): string {
  const header = '"Row","Phone","Name","Error"';
  const lines = failures.map(f =>
    [escapeCsvCell(f.rowNumber), escapeCsvCell(f.phone), escapeCsvCell(f.name), escapeCsvCell(f.error)].join(','),
  );
  return [header, ...lines].join('\r\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test "src/utils/contactCsv.test.ts"` inside `dashboard/`
Expected: PASS with all tests passing.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/utils/contactCsv.ts dashboard/src/utils/contactCsv.test.ts
git commit -m "feat(dashboard): add contact csv parser and normalization utilities"
```

---

### Task 2: Extend Contact API in Dashboard Client

**Files:**
- Modify: `dashboard/src/services/api.ts`

**Interfaces:**
- Consumes: Existing NestJS backend routes `/sessions/:sessionId/contacts/:contactId`.
- Produces:
  ```typescript
  contactApi.upsertContact(
    sessionId: string,
    contactId: string,
    data: { firstName: string; lastName?: string }
  ): Promise<{ success: boolean; message: string }>;

  contactApi.deleteContact(
    sessionId: string,
    contactId: string
  ): Promise<{ success: boolean; message: string }>;

  contactApi.blockContact(
    sessionId: string,
    contactId: string
  ): Promise<{ success: boolean; message: string }>;

  contactApi.unblockContact(
    sessionId: string,
    contactId: string
  ): Promise<{ success: boolean; message: string }>;
  ```

- [ ] **Step 1: Add contact mutation methods to `contactApi` in `dashboard/src/services/api.ts`**

In `dashboard/src/services/api.ts`, add to `contactApi`:
```typescript
  upsertContact: (sessionId: string, contactId: string, data: { firstName: string; lastName?: string }) =>
    request<{ success: boolean; message: string }>(
      `/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      },
    ),
  deleteContact: (sessionId: string, contactId: string) =>
    request<{ success: boolean; message: string }>(
      `/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}`,
      { method: 'DELETE' },
    ),
  blockContact: (sessionId: string, contactId: string) =>
    request<{ success: boolean; message: string }>(
      `/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/block`,
      { method: 'POST' },
    ),
  unblockContact: (sessionId: string, contactId: string) =>
    request<{ success: boolean; message: string }>(
      `/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/block`,
      { method: 'DELETE' },
    ),
```

- [ ] **Step 2: Run typecheck to verify types**

Run: `npm run typecheck` inside `dashboard/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/services/api.ts
git commit -m "feat(dashboard): add contact upsert and block methods to contactApi"
```

---

### Task 3: Contact CSV Import Modal Component

**Files:**
- Create: `dashboard/src/components/ContactCsvImportModal.tsx`
- Create: `dashboard/src/components/ContactCsvImportModal.css`
- Test: `dashboard/src/components/ContactCsvImportModal.test.ts`

**Interfaces:**
- Consumes: `contactApi`, `contactCsv.ts`.
- Produces:
  ```typescript
  export interface ContactCsvImportModalProps {
    sessionId: string;
    existingContacts?: Contact[];
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
  }
  ```

- [ ] **Step 1: Write tests for import queue and processing logic**

Create `dashboard/src/components/ContactCsvImportModal.test.ts` testing the worker pool throttling, cancellation, and failed row reporting.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test "src/components/ContactCsvImportModal.test.ts"` inside `dashboard/`
Expected: FAIL

- [ ] **Step 3: Implement `ContactCsvImportModal.tsx` and `ContactCsvImportModal.css`**

Implement the 4-step wizard:
- Step 1 (Upload): File input / dropzone accepting `.csv` up to 5MB.
- Step 2 (Mapping): Dropdowns for Phone, First Name, Last Name, toggle for Single Name Column, checkboxes for "Validate on WhatsApp" and "Skip if already in addressbook".
- Step 3 (Preview): Shows first 5 records with validation status, total count, valid/invalid breakdown.
- Step 4 (Execute): Throttled queue (concurrency 3, 50ms inter-dispatch), live progress bar, pause/resume, cancel button, failure list with "Download Errors CSV" button.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test "src/components/ContactCsvImportModal.test.ts"` inside `dashboard/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/ContactCsvImportModal.tsx dashboard/src/components/ContactCsvImportModal.css dashboard/src/components/ContactCsvImportModal.test.ts
git commit -m "feat(dashboard): create contact csv import wizard modal component"
```

---

### Task 4: Contacts Page Component

**Files:**
- Create: `dashboard/src/pages/Contacts.tsx`
- Create: `dashboard/src/pages/Contacts.css`
- Test: `dashboard/src/pages/Contacts.test.ts`

**Interfaces:**
- Consumes: `contactApi`, `sessionApi`, `ContactCsvImportModal`.
- Produces: Default export `Contacts` page component.

- [ ] **Step 1: Write component unit test for `Contacts` page filtering and actions**

Create `dashboard/src/pages/Contacts.test.ts`:
Test contact search filtering by name and phone, addressbook filter, empty state, and session selector.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test "src/pages/Contacts.test.ts"` inside `dashboard/`
Expected: FAIL

- [ ] **Step 3: Implement `Contacts.tsx` and `Contacts.css`**

- Session selector syncing with query param `?session=...`.
- Stats banner: Total Contacts, In Addressbook, Blocked.
- Search filter input + dropdown filter (`all`, `addressbook`, `unknown`, `blocked`).
- Action buttons: "Import CSV" (opens modal) and "Refresh".
- Paginated table (50 rows/page) showing Avatar (with fallback initials), Name, Phone, Status badges, and Actions (Chat link, Edit name, Block/Unblock).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test "src/pages/Contacts.test.ts"` inside `dashboard/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/pages/Contacts.tsx dashboard/src/pages/Contacts.css dashboard/src/pages/Contacts.test.ts
git commit -m "feat(dashboard): create contacts page component with table and search"
```

---

### Task 5: Integrate Navigation, Routing & Localization

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/Layout.tsx`
- Modify: `dashboard/src/i18n/locales/*.json` (all 13 locale files: `en.json`, `ar.json`, `de.json`, `es.json`, `fr.json`, `he.json`, `it.json`, `ko.json`, `pt-BR.json`, `te.json`, `tr.json`, `zh-CN.json`, `zh-HK.json`)

**Interfaces:**
- Consumes: `Contacts` page from `dashboard/src/pages/Contacts.tsx`.
- Produces: Accessible `/contacts` route and sidebar entry with full i18n parity.

- [ ] **Step 1: Add lazy route for `Contacts` in `App.tsx`**

Add `const Contacts = lazy(() => import('./pages/Contacts').then(m => ({ default: m.Contacts })));`
And inside `<Routes>`:
`<Route path="contacts" element={<Contacts />} />`

- [ ] **Step 2: Add `Contacts` navigation item in `Layout.tsx`**

Import `ContactRound` from `lucide-react`.
Add `{ to: '/contacts', icon: ContactRound, key: 'contacts' as const, adminOnly: false }` directly after `/chats`.

- [ ] **Step 3: Add `nav.contacts` and `contacts.*` translation keys across all 13 locale files**

Ensure every locale file contains:
```json
"nav": {
  ...
  "contacts": "Contacts"
},
"contacts": {
  "title": "Contacts",
  "importCsv": "Import CSV",
  ...
}
```
Run `npm run i18n:check` to verify complete parity without missing keys.

- [ ] **Step 4: Run `npm run i18n:check` to verify parity**

Run: `npm run i18n:check` inside `dashboard/`
Expected: PASS (0 missing keys across all 13 languages).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/App.tsx dashboard/src/components/Layout.tsx dashboard/src/i18n/locales/*.json
git commit -m "feat(dashboard): register contacts route, sidebar navigation, and i18n translations"
```

---

### Task 6: Full Verification & Build Check

**Files:**
- Entire codebase.

- [ ] **Step 1: Run complete test suite**

Run: `npm test` inside `dashboard/`
Expected: All tests pass (including existing 414 tests + new contact tests).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck` inside `dashboard/`
Expected: PASS with 0 errors.

- [ ] **Step 3: Run production build**

Run: `npm run build` inside `dashboard/`
Expected: PASS with clean build.

- [ ] **Step 4: Commit and push changes**

```bash
git push origin main
```
