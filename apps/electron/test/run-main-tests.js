'use strict';

/**
 * Runs the main-process test files under Electron's Node runtime.
 *
 * They cannot run under plain `node`: better-sqlite3 is a native module built
 * against Electron's ABI (see `npm run rebuild-native`), so loading it from the
 * system Node fails with NODE_MODULE_VERSION mismatch. `ELECTRON_RUN_AS_NODE`
 * starts Electron as a bare Node process — no window, no Chromium — which is
 * the same runtime main.js gets.
 *
 * Spawned from here rather than set inline in the npm script so this works on
 * Windows too, without adding cross-env.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron');

const TESTS = ['database.test.js'];

let failed = 0;

for (const file of TESTS) {
  console.log(`\n─── ${file} ${'─'.repeat(Math.max(0, 60 - file.length))}`);

  const result = spawnSync(electron, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  if (result.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed.`);
  process.exit(1);
}

console.log('\nAll main-process tests passed.');
