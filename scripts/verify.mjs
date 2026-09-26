/**
 * Release verification gate (v7).
 *
 * Runs every acceptance gate IN ORDER against the CURRENT source and a
 * FRESHLY built artifact, then writes
 * `.agents/block-the-slop-v7/RELEASE_EVIDENCE.json` with:
 *   - the exact source tree fingerprint (see fingerprintRule),
 *   - per-gate command + exit code + duration,
 *   - browser versions used by the E2E run,
 *   - artifact hashes (build manifests, zips) — null hashes FAIL the run,
 *   - fixture vs live evidence distinction.
 *
 * This command verifies build/test gates and artifact hashes. Product
 * requirements involving live YouTube, Firefox extension runtime, or a
 * competitor side-by-side still require separately recorded evidence.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = join(root, '.agents', 'block-the-slop-v7');

const gates = [
  { name: 'icons', cmd: 'npm run icons', required: true },
  { name: 'format:check', cmd: 'npm run format:check', required: true },
  { name: 'lint', cmd: 'npm run lint', required: true },
  { name: 'typecheck', cmd: 'npm run typecheck', required: true },
  { name: 'unit', cmd: 'npm test', required: true },
  { name: 'build', cmd: 'npm run build', required: true },
  {
    name: 'e2e:chromium-extension',
    cmd: 'npx playwright test --project=chromium-extension',
    required: true,
  },
  { name: 'e2e:firefox-smoke', cmd: 'npx playwright test --project=firefox-smoke', required: true },
  { name: 'build:firefox', cmd: 'npm run build:firefox', required: true },
  { name: 'zip', cmd: 'npm run zip', required: true },
  { name: 'zip:firefox', cmd: 'npm run zip:firefox', required: true },
];

// ---- fingerprint: SHA-256 over sorted repo file names + contents ----------
// Excludes generated/volatile dirs; matches the rule in state.json.
const EXCLUDED_DIRS = new Set([
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

function collectFiles(dir, base = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) collectFiles(full, base, out);
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

function sourceFingerprint() {
  const hash = createHash('sha256');
  for (const rel of collectFiles(root).sort()) {
    hash.update(rel);
    hash.update('\u0000');
    hash.update(readFileSync(join(root, rel)));
    hash.update('\u0001');
  }
  return hash.digest('hex');
}

// ---- browser versions (from the installed Playwright browsers) ------------
function browserVersions() {
  const out = { chromium: null, firefox: null };
  const pwRoot = join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '', 'ms-playwright');
  if (!existsSync(pwRoot)) return out;
  for (const dir of readdirSync(pwRoot)) {
    if (dir.startsWith('chromium-')) out.chromium = dir;
    if (dir.startsWith('firefox-')) out.firefox = dir;
  }
  return out;
}

function hashFile(path) {
  if (!existsSync(path)) return null;
  const contents = readFileSync(path);
  return {
    sha256: createHash('sha256').update(contents).digest('hex'),
    bytes: statSync(path).size,
  };
}

// ---- gates -----------------------------------------------------------------
const gateResults = [];
for (const gate of gates) {
  const started = Date.now();
  process.stdout.write(`\n=== GATE ${gate.name}: ${gate.cmd}\n`);
  const result = spawnSync(gate.cmd, {
    cwd: root,
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });
  const durationMs = Date.now() - started;
  gateResults.push({
    name: gate.name,
    cmd: gate.cmd,
    exit: result.status,
    durationMs,
    required: gate.required,
  });
  if (result.status !== 0) {
    process.stderr.write(`\n✗ GATE FAILED: ${gate.name} (exit ${result.status})\n`);
    // Write partial evidence even on failure so the checker can see WHICH
    // gate failed and when (never silently stale).
    writeEvidence(gateResults, true);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`✓ ${gate.name}\n`);
}

function writeEvidence(gates, failed, failureNote) {
  const fingerprint = sourceFingerprint();
  const artifacts = {
    'chrome-mv3/manifest.json': hashFile(join(root, '.output', 'chrome-mv3', 'manifest.json')),
    'firefox-mv2/manifest.json': hashFile(join(root, '.output', 'firefox-mv2', 'manifest.json')),
    'chrome.zip': hashFile(join(root, '.output', 'block-the-slop-1.0.0-chrome.zip')),
    'firefox.zip': hashFile(join(root, '.output', 'block-the-slop-1.0.0-firefox.zip')),
    'sources.zip': hashFile(join(root, '.output', 'block-the-slop-1.0.0-sources.zip')),
  };
  const missingArtifacts = Object.entries(artifacts)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (missingArtifacts.length > 0 && !failed) {
    process.stderr.write(`✗ Missing/null artifact hashes: ${missingArtifacts.join(', ')}\n`);
    process.exit(1);
  }
  const evidence = {
    schemaVersion: 6,
    runId: `verify-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    fingerprintRule:
      'SHA-256 over sorted repo file names + contents, excluding .output, node_modules, test-results, kit dirs, .git, .freebuff, .agents.',
    gates,
    browsers: browserVersions(),
    artifacts,
    evidenceBoundary: {
      fixture:
        'tests/e2e assert real visibility against .output/chrome-mv3 on fixture pages under tests/e2e/fixtures/www.youtube.com',
      live: 'NOT recorded by this run — live youtube.com checks remain a separate manual procedure; do not cite fixture evidence as live evidence',
      firefoxRuntime:
        'UNVERIFIED — Playwright Firefox cannot load extensions; the firefox-smoke project verifies artifact integrity + real browser launch only',
    },
    ...(failed ? { failed: true, failureNote: failureNote ?? 'a gate exited nonzero' } : {}),
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, 'RELEASE_EVIDENCE.json'), JSON.stringify(evidence, null, 2));
}

writeEvidence(gateResults, false);
process.stdout.write(
  `\n✓ ALL GATES PASSED — evidence written to .agents/block-the-slop-v7/RELEASE_EVIDENCE.json\n`,
);
