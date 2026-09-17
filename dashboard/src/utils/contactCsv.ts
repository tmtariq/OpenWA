import { escapeCsvCell } from './csv.ts';

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
    firstNameIndex: firstNameIndex >= 0 ? firstNameIndex : phoneIndex === 0 && headers.length > 1 ? 1 : 0,
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
  if (!trimmed) return { firstName: '', lastName: undefined };

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) {
    return { firstName: trimmed, lastName: undefined };
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

    let firstName: string;
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

function formatFailedCsvCell(value: unknown): string {
  const cell = escapeCsvCell(value);
  if (cell.startsWith('"') && cell.endsWith('"')) {
    return cell;
  }
  return `"${cell.replace(/"/g, '""')}"`;
}

export function exportFailedRowsToCsv(
  failures: { rowNumber: number; phone: string; name: string; error: string }[],
): string {
  const header = '"Row","Phone","Name","Error"';
  const lines = failures.map(f =>
    [
      formatFailedCsvCell(f.rowNumber),
      formatFailedCsvCell(f.phone),
      formatFailedCsvCell(f.name),
      formatFailedCsvCell(f.error),
    ].join(','),
  );
  return [header, ...lines].join('\r\n');
}
