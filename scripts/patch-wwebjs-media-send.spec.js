'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyMediaSendPatches,
  isApplied,
  MEDIA_SEND_FIND,
  MEDIA_SEND_REPLACE,
  UTILS_PATH,
} = require('./patch-wwebjs-media-send');

function fakeWwjs(utilsSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-media-send-'));
  const utilsDir = path.join(dir, path.dirname(UTILS_PATH));
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.writeFileSync(path.join(dir, UTILS_PATH), utilsSource);
  return { dir, utilsFile: path.join(dir, UTILS_PATH) };
}

const PRISTINE = `exports.sendMessage = async () => {\n    const message = {\n${MEDIA_SEND_FIND}\n    };\n};\n`;

test('applies media send repair to a pristine upstream tree', () => {
  const { dir, utilsFile } = fakeWwjs(PRISTINE);

  const result = applyMediaSendPatches(dir);

  assert.equal(result.skipped, false);
  assert.equal(result.note, 'mediaOptions model pollution avoided in sendMessage');
  const patched = fs.readFileSync(utilsFile, 'utf8');
  assert.ok(patched.includes(MEDIA_SEND_REPLACE));
  assert.ok(!patched.includes(MEDIA_SEND_FIND));
});

test('isApplied tracks the transform: false on pristine, true once patched', () => {
  const { dir } = fakeWwjs(PRISTINE);

  assert.equal(isApplied(dir), false);
  applyMediaSendPatches(dir);
  assert.equal(isApplied(dir), true);
});

test('is idempotent — a second run is a no-op, not a double patch', () => {
  const { dir, utilsFile } = fakeWwjs(PRISTINE);
  applyMediaSendPatches(dir);
  const once = fs.readFileSync(utilsFile, 'utf8');

  const result = applyMediaSendPatches(dir);

  assert.equal(result.skipped, true);
  assert.match(result.reason, /already avoids/);
  assert.equal(fs.readFileSync(utilsFile, 'utf8'), once);
});

test('refuses an upstream shape it does not recognise', () => {
  const { dir, utilsFile } = fakeWwjs('exports.sendMessage = async () => {\n    const message = {};\n};\n');
  const before = fs.readFileSync(utilsFile, 'utf8');

  assert.throws(() => applyMediaSendPatches(dir), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utilsFile, 'utf8'), before);
});

test('refuses when the target snippet appears more than once', () => {
  const { dir } = fakeWwjs(PRISTINE + PRISTINE);

  assert.throws(() => applyMediaSendPatches(dir), /unpatched: 2/);
});

test('refuses a tree containing both unpatched and patched forms', () => {
  const { dir, utilsFile } = fakeWwjs(`${PRISTINE}\n${MEDIA_SEND_REPLACE}\n`);
  const before = fs.readFileSync(utilsFile, 'utf8');

  assert.throws(() => applyMediaSendPatches(dir), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utilsFile, 'utf8'), before);
});

test('reports a missing whatsapp-web.js rather than pretending to patch it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-media-send-empty-'));

  assert.throws(() => applyMediaSendPatches(dir), /Utils\.js not found/);
});

test('CLI: unrecognised tree exits 1 bare and 0 under --best-effort', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-media-send-cli-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'patch-wwebjs-media-send.js');
  fs.copyFileSync(path.join(__dirname, 'patch-wwebjs-media-send.js'), script);
  const utilsDir = path.join(root, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected');
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.writeFileSync(path.join(utilsDir, 'Utils.js'), 'exports.x = () => {};\n');

  const bare = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bare.status, 1, 'production image build must fail on a tree the patcher cannot repair');
  assert.match(bare.stderr, /unsupported Utils\.js shape/);

  const bestEffort = spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' });
  assert.equal(bestEffort.status, 0, 'postinstall must not fail an install the patcher cannot help');
  assert.match(bestEffort.stderr, /skipped/);
});
