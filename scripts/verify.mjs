/**
 * SET-05 / QA-13: the release verification gate.
 *
 * Runs every acceptance gate IN ORDER against the CURRENT source and a
 * FRESHLY built artifact. Any failure exits nonzero — completion cannot be
 * claimed from stale or partial evidence. On success it writes
 * `.agents/block-the-slop-v2/RELEASE_EVIDENCE.json` with artifact hashes.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gates = [
  { name: 'icons', cmd: 'npm run icons' },
  { name: 'format:check', cmd: 'npm run format:check' },
  { name: 'lint', cmd: 'npm run lint' },
  { name: 'typecheck', cmd: 'npm run typecheck' },
  { name: 'unit', cmd: 'npm test' },
  { name: 'build', cmd: 'npm run build' },
  { name: 'build:firefox', cmd: 'npm run build:firefox' },
  { name: 'e2e', cmd: 'npm run test:e2e' },
  { name: 'zip', cmd: 'npm run zip' },
  { name: 'zip:firefox', cmd: 'npm run zip:firefox' },
];

function run(name, cmd) {
  process.stdout.write(`\n=== GATE ${name}: ${cmd}\n`);
  const result = spawnSync(cmd, {
    cwd: root,
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.stderr.write(`\n✗ GATE FAILED: ${name} (exit ${result.status})\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`✓ ${name}\n`);
}

function hashFile(path) {
  if (!existsSync(path)) return null;
  const contents = readFileSync(path);
  return {
    sha256: createHash('sha256').update(contents).digest('hex'),
    bytes: statSync(path).size,
  };
}

for (const gate of gates) run(gate.name, gate.cmd);

// ---- freshness: e2e must have run AFTER the chrome build ----
const chromeBuild = join(root, '.output', 'chrome-mv3', 'manifest.json');
const ffBuild = join(root, '.output', 'firefox-mv2', 'manifest.json');
if (!existsSync(chromeBuild) || !existsSync(ffBuild)) {
  process.stderr.write('✗ Built artifacts missing after build gates.\n');
  process.exit(1);
}

const chromeZip = join(root, '.output', 'block-the-slop-1.0.0-chrome.zip');
const ffZip = join(root, '.output', 'block-the-slop-1.0.0-firefox.zip');
const evidence = {
  generatedAt: new Date().toISOString(),
  gates: gates.map((g) => g.name),
  artifacts: {
    'chrome-mv3/manifest.json': hashFile(chromeBuild),
    'firefox-mv2/manifest.json': hashFile(ffBuild),
    'chrome.zip': hashFile(chromeZip),
    'firefox.zip': hashFile(ffZip),
  },
};

const evidenceDir = join(root, '.agents', 'block-the-slop-v2');
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, 'RELEASE_EVIDENCE.json'), JSON.stringify(evidence, null, 2));
process.stdout.write(
  `\n✓ ALL GATES PASSED — evidence written to .agents/block-the-slop-v2/RELEASE_EVIDENCE.json\n`,
);
