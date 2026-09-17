import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContactCsv,
  detectContactColumns,
  normalizePhoneNumber,
  splitFullName,
  mapRowsToCandidates,
  exportFailedRowsToCsv,
} from './contactCsv.ts';

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

    const tabCsv = 'Full Name\tCell\n"Jane ""Doc"" Doe"\t+19876543210';
    const parsedTab = parseContactCsv(tabCsv);
    assert.deepEqual(parsedTab.headers, ['Full Name', 'Cell']);
    assert.deepEqual(parsedTab.rows[0], ['Jane "Doc" Doe', '+19876543210']);
  });

  it('handles empty or whitespace CSV strings', () => {
    assert.deepEqual(parseContactCsv(''), { headers: [], rows: [] });
    assert.deepEqual(parseContactCsv('   \r\n  \n  '), { headers: [], rows: [] });
  });

  it('detects columns using content scanning fallback if headers are obscure', () => {
    const obscureHeaders = ['ColA', 'ColB', 'ColC'];
    const rows = [['CustomValue', '9876543210', 'SomethingElse']];
    const mapping = detectContactColumns(obscureHeaders, rows);
    assert.equal(mapping.phoneIndex, 1);
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
    assert.deepEqual(splitFullName(''), { firstName: '', lastName: undefined });
  });

  it('maps rows to normalized contact candidates with single name column', () => {
    const rows = [
      ['John Doe', '+1 (555) 234-5678'],
      ['', '+44 7700 900077'],
      ['Invalid User', '123'],
    ];
    const mapping = {
      phoneIndex: 1,
      firstNameIndex: 0,
      lastNameIndex: -1,
      hasSingleNameColumn: true,
    };
    const candidates = mapRowsToCandidates(rows, mapping);
    assert.equal(candidates.length, 3);

    // Row 1: valid, split name
    assert.equal(candidates[0].rowIndex, 2);
    assert.equal(candidates[0].firstName, 'John');
    assert.equal(candidates[0].lastName, 'Doe');
    assert.equal(candidates[0].normalizedPhone, '15552345678');
    assert.equal(candidates[0].jid, '15552345678@c.us');
    assert.equal(candidates[0].isValid, true);

    // Row 2: empty name defaults to normalized phone
    assert.equal(candidates[1].rowIndex, 3);
    assert.equal(candidates[1].firstName, '447700900077');
    assert.equal(candidates[1].normalizedPhone, '447700900077');
    assert.equal(candidates[1].isValid, true);

    // Row 3: invalid short phone
    assert.equal(candidates[2].rowIndex, 4);
    assert.equal(candidates[2].isValid, false);
    assert.match(candidates[2].invalidReason || '', /minimum 6 digits/i);
  });

  it('maps rows with separate first and last name columns', () => {
    const rows = [['Alice', 'Smith', '+15551234567']];
    const mapping = {
      phoneIndex: 2,
      firstNameIndex: 0,
      lastNameIndex: 1,
      hasSingleNameColumn: false,
    };
    const candidates = mapRowsToCandidates(rows, mapping);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].firstName, 'Alice');
    assert.equal(candidates[0].lastName, 'Smith');
    assert.equal(candidates[0].normalizedPhone, '15551234567');
    assert.equal(candidates[0].isValid, true);
  });

  it('exports failed rows to CSV with formula-injection sanitization', () => {
    const failures = [
      { rowNumber: 2, phone: '12345', name: '=CMD|calc', error: 'Invalid phone' },
      { rowNumber: 3, phone: '+123456', name: '+SUM(A1)', error: 'Error, with comma' },
      { rowNumber: 4, phone: '999999', name: '@dangerous', error: 'Normal error' },
    ];
    const exported = exportFailedRowsToCsv(failures);
    assert.match(exported, /"Row","Phone","Name","Error"/);
    assert.match(exported, /"'=CMD\|calc"/); // formula sanitized
    assert.match(exported, /"'\+SUM\(A1\)"/); // formula sanitized with +
    assert.match(exported, /"'@dangerous"/); // formula sanitized with @
    assert.match(exported, /"Error, with comma"/); // comma preserved within quotes
  });
});
