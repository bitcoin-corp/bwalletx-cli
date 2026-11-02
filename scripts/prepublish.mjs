#!/usr/bin/env node
/**
 * prepublishOnly: refuses to publish unless
 *   1. the git tree is clean (no changes, no untracked files),
 *   2. HEAD is tagged v<version from package.json>,
 * then rebuilds dist/ from scratch, runs the full test suite, and scans what will ship (dist/, README.md)
 * for owner or company specifics and key-like strings. Any failure stops the publish.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const fail = (m) => {
  console.error(`prepublishOnly refused: ${m}`);
  process.exit(1);
};
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

let status;
try {
  status = git('status', '--porcelain', '--untracked-files=all');
} catch {
  fail('not inside a git checkout');
}
if (status) fail(`the git tree is not clean:\n${status}`);
const tags = git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean);
if (!tags.includes(`v${version}`)) fail(`HEAD is not tagged v${version} (tags on HEAD: ${tags.join(', ') || 'none'}). Tag the release commit first.`);

const bin = (n) => join(root, 'node_modules', '.bin', n);
rmSync(join(root, 'dist'), { recursive: true, force: true });
execFileSync(bin('tsc'), ['-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
chmodSync(join(root, 'dist', 'cli.js'), 0o755);
execFileSync(bin('vitest'), ['run'], { cwd: root, stdio: 'inherit' });

// What ships: dist/ + README.md (+ LICENSE, package.json). No owner/company specifics, no keys.
const FORBIDDEN = [/bcorp/i, /bstamp/i, /treasury/i, /richard@/i, /SEAL-REGISTER/i];
const WIF = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b|\bc[1-9A-HJ-NP-Za-km-z]{51}\b/;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const files = [join(root, 'README.md')];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(join(root, 'dist'));
const hits = [];
for (const f of files) {
  if (/\.test\.(js|d\.ts)$/.test(f)) hits.push(`${f}: a test file would ship`);
  const s = readFileSync(f, 'utf8');
  for (const re of [...FORBIDDEN, WIF, PEM]) if (re.test(s)) hits.push(`${f}: matches ${re}`);
}
if (hits.length) fail(`the package would ship:\n  ${hits.join('\n  ')}`);
console.log(`prepublishOnly: v${version} clean, tagged, rebuilt, tested, scanned.`);
