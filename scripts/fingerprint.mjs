/**
 * V4 fingerprint tool — same rule as scripts/verify.mjs (SHA-256 over sorted
 * repo file names + contents, excluding generated/kit dirs). Written as a
 * file (not inline eval) so the rule is runnable verbatim on any shell.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const EX = new Set([
  '.output',
  'node_modules',
  'test-results',
  'playwright-report',
  '.git',
  '.freebuff',
  '.agents',
  'block-the-slop-upgrade-agent-kit',
  'block-the-slop-next-loop-audit-kit',
  'block-the-slop-v4-loop-kit',
  'block-the-slop-v5-loop-kit',
  'block-the-slop-v6-loop-kit',
]);

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (EX.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) collect(full, out);
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

const hash = createHash('sha256');
for (const rel of collect(root).sort()) {
  hash.update(rel);
  hash.update('\u0000');
  hash.update(readFileSync(join(root, rel)));
  hash.update('\u0001');
}
console.log(hash.digest('hex'));
