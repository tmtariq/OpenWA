/**
 * Prevent raw MediaData model properties from polluting message options in whatsapp-web.js.
 *
 * In `window.WWebJS.sendMessage` (`src/util/Injected/Utils.js`), message options are constructed
 * when sending media as:
 *
 * ```js
 * ...mediaOptions,
 * ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),
 * ```
 *
 * Spreading `...mediaOptions` directly copies internal BaseModel instance properties
 * (such as `__x_id: '1'`, `collection`, `_uiObservers`), which clobbers Msg model initialization.
 * In current WhatsApp Web builds, this causes `getSender(this)` and internal getter memoization
 * to fail with:
 * `Error: Data passed to getter must include an id property (it's how we memoize) but got undefined`.
 * This manifests as an opaque 500 when sending images, documents, audio, or video.
 *
 * Replacing the spread with:
 * ```js
 * ...(mediaOptions.toJSON ? mediaOptions.toJSON() : mediaOptions),
 * ```
 * ensures that only the serialized media options (or plain object if not a model) are merged,
 * preventing model pollution while preserving all required media properties.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

const MEDIA_SEND_FIND = `            ...mediaOptions,
            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),`;

const MEDIA_SEND_REPLACE = `            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : mediaOptions),`;

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const source = fs.readFileSync(path.join(wwjsDir, UTILS_PATH), 'utf8');
    return occurrences(source, MEDIA_SEND_REPLACE) === 1 && occurrences(source, MEDIA_SEND_FIND) === 0;
  } catch {
    return true;
  }
}

function applyMediaSendPatches(wwjsDir = DEFAULT_WWJS) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }

  let source = fs.readFileSync(utilsFile, 'utf8');
  const findCount = occurrences(source, MEDIA_SEND_FIND);
  const replaceCount = occurrences(source, MEDIA_SEND_REPLACE);

  if (findCount === 0 && replaceCount === 1) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already avoids mediaOptions model pollution',
    };
  }
  if (findCount !== 1 || replaceCount !== 0) {
    throw new Error(
      `unsupported Utils.js shape (unpatched: ${findCount}, patched: ${replaceCount}); ` +
        're-evaluate the media send fix against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(utilsFile, source.replace(MEDIA_SEND_FIND, MEDIA_SEND_REPLACE));
  return { skipped: false, note: 'mediaOptions model pollution avoided in sendMessage' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyMediaSendPatches();
    console.log(`patch-wwebjs-media-send: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-media-send: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-media-send: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = {
  applyMediaSendPatches,
  isApplied,
  MEDIA_SEND_FIND,
  MEDIA_SEND_REPLACE,
  UTILS_PATH,
};
