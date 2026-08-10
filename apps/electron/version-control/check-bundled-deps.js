#!/usr/bin/env node
'use strict';

/**
 * Verifies that electron-builder's node_modules allowlist still covers every
 * module the packaged main process can require.
 *
 * Why this exists: this is an npm-workspaces monorepo, so dependencies hoist to
 * the repo root and `apps/electron/node_modules` is nearly empty. That defeats
 * electron-builder's normal "bundle the app's production dependencies"
 * behaviour, so `build.files` maps `../../node_modules` in by hand with an
 * explicit filter.
 *
 * A hand-written list of transitive dependencies cannot stay correct. It had
 * drifted to 22 entries against a real closure of 92 — including `ws`, which
 * `league-connect` requires eagerly, so every installed build died on launch
 * with "Cannot find module 'ws'" before showing a window. Nothing in the dev
 * workflow catches that: `ng serve` and `electron .` both resolve from the
 * root `node_modules`, which has everything.
 *
 * Run with `--fix` to rewrite the filter in place.
 *
 * Renderer dependencies are deliberately out of scope. Angular bundles those
 * into `dist/`, so they are never resolved from `node_modules` at runtime.
 */

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_DIR, '..', '..');
const ROOT_NM = path.join(REPO_ROOT, 'node_modules');
const APP_NM = path.join(APP_DIR, 'node_modules');
const PKG_PATH = path.join(APP_DIR, 'package.json');

/**
 * What the main process require()s directly. Everything else in the bundle is
 * reached transitively from here.
 *
 * Keep in sync with the requires at the top of main.js, preload.js,
 * database.js, lcu-monitor.js and riot-api.service.js.
 */
const ENTRY_POINTS = ['electron-updater', 'better-sqlite3', 'league-connect', 'twisted'];

/** Type-only packages are never require()d at runtime. */
const isTypesOnly = (name) => name.startsWith('@types/');

function readPkg(name) {
  for (const base of [APP_NM, ROOT_NM]) {
    const file = path.join(base, name, 'package.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

/** Transitive closure of runtime dependencies, as sorted package names. */
function computeClosure() {
  const seen = new Set();
  const unresolved = new Set();

  const walk = (name) => {
    if (seen.has(name) || isTypesOnly(name)) return;
    seen.add(name);

    const pkg = readPkg(name);
    if (!pkg) {
      unresolved.add(name);
      return;
    }

    for (const dep of Object.keys(pkg.dependencies || {})) walk(dep);
    // Optional deps only matter when actually installed.
    for (const dep of Object.keys(pkg.optionalDependencies || {})) {
      if (readPkg(dep)) walk(dep);
    }
  };

  ENTRY_POINTS.forEach(walk);
  return { closure: [...seen].sort(), unresolved: [...unresolved] };
}

/**
 * Local `./` modules reachable from the main process, as file names.
 *
 * These are hand-listed in `build.files` too, and had exactly the same drift
 * problem: `rate-limiter.js` and `timeline-compact.js` were never added, so the
 * packaged app died on `Cannot find module './rate-limiter'` immediately after
 * the missing-`ws` failure was cleared.
 */
function localModules() {
  const entries = ['main.js', 'preload.js'];
  const seen = new Set();

  const walk = (file) => {
    if (seen.has(file)) return;
    const abs = path.join(APP_DIR, file);
    if (!fs.existsSync(abs)) return;
    seen.add(file);

    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
      walk(m[1].endsWith('.js') ? m[1] : `${m[1]}.js`);
    }
  };

  entries.forEach(walk);
  return [...seen].sort();
}

function checkLocalFiles(pkg) {
  const listed = new Set(
    (pkg.build?.files || []).filter((f) => typeof f === 'string')
  );
  const missing = localModules().filter((f) => !listed.has(f));

  if (missing.length) {
    console.error(
      `[deps] ${missing.length} local main-process file(s) missing from build.files:\n` +
        missing.map((n) => `  - ${n}`).join('\n')
    );
    return false;
  }
  return true;
}

function main() {
  const fix = process.argv.includes('--fix');
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

  const entry = (pkg.build?.files || []).find(
    (f) => f && typeof f === 'object' && f.from === '../../node_modules'
  );
  if (!entry) {
    console.error('[deps] no ../../node_modules mapping in build.files — nothing to check.');
    process.exit(1);
  }

  const { closure, unresolved } = computeClosure();
  if (unresolved.length) {
    console.error(`[deps] not installed: ${unresolved.join(', ')} — run npm install.`);
    process.exit(1);
  }

  const localsOk = checkLocalFiles(pkg);

  const listed = new Set(entry.filter.map((f) => f.replace(/\/\*\*$/, '')));
  const missing = closure.filter((name) => !listed.has(name));

  if (!missing.length) {
    if (!localsOk) process.exit(1);
    console.log(
      `[deps] OK — ${closure.length} node modules and ${localModules().length} local files bundled.`
    );
    return;
  }

  if (fix) {
    entry.filter = closure.map((name) => `${name}/**`);
    fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`[deps] filter rewritten with ${closure.length} modules.`);
    // Local files are listed by hand alongside other build inputs, so they are
    // reported rather than rewritten — inserting them blindly risks reordering
    // entries whose position matters.
    if (!localsOk) process.exit(1);
    return;
  }

  console.error(
    `[deps] ${missing.length} runtime module(s) would be missing from the packaged app:\n` +
      missing.map((n) => `  - ${n}`).join('\n') +
      '\n\nThe installed app will crash on launch. Run:\n' +
      '  npm run check:deps -- --fix   (from apps/electron)\n'
  );
  process.exit(1);
}

main();
