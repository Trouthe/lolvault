const { writeFileSync } = require('fs-extra');
const { resolve } = require('path');
const gitCommitCount = require('./git-commit-count');
const { readFileSync } = require('fs');

const count = gitCommitCount();

async function getVersionAndWrite() {
  const pkgPath = resolve(__dirname, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const version = pkg.version || '0.0.0';
  writeInfo(version, count);
}

function writeInfo(version, count) {
  const content = `// IMPORTANT: THIS FILE IS AUTO GENERATED! DO NOT MANUALLY EDIT OR CHECKIN!
export const VERSION = '${version}';
export const REVISION = ${count || 0};`;

  const filePath = resolve(__dirname, '../src/environments/version.ts');
  writeFileSync(filePath, content, { encoding: 'utf8' });

  console.log(`Version information updated: ${version}, Revision: ${count || 0}`);
}

getVersionAndWrite();
