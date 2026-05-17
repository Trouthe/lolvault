const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');
const gitCommitCount = require('./git-commit-count');

const WEB_BUILD_PREFIX = 'w';
const WEB_BUILD_STAMP = '517';
const DEFAULT_WEB_REVISION = '001';

function normalizeRevision(rawRevision) {
  const cleaned = String(rawRevision || '')
    .trim()
    .replace(/[^0-9]/g, '');

  if (!cleaned) {
    return '';
  }

  return cleaned.padStart(3, '0');
}

function getRevision() {
  const envRevision = normalizeRevision(process.env.WEB_BUILD_REVISION);
  if (envRevision) {
    return envRevision;
  }

  const gitRevision = normalizeRevision(gitCommitCount());
  if (gitRevision) {
    return gitRevision;
  }

  return DEFAULT_WEB_REVISION;
}

function getVersionAndWrite() {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = pkg.version || '0.0.0';
  const revision = getRevision();
  writeInfo(version, revision);
}

function writeInfo(version, revision) {
  const buildLabel = `${WEB_BUILD_PREFIX}.${WEB_BUILD_STAMP}-${revision}`;

  const content = `// IMPORTANT: THIS FILE IS AUTO GENERATED! DO NOT MANUALLY EDIT OR CHECKIN!\nexport const VERSION = '${version}';\nexport const REVISION = '${revision}';\nexport const BUILD_LABEL = '${buildLabel}';`;

  const filePath = resolve(__dirname, '../src/environments/version.ts');
  writeFileSync(filePath, content, { encoding: 'utf8' });

  console.log(`Web version information updated: ${version}, Build: ${buildLabel}`);
}

getVersionAndWrite();
