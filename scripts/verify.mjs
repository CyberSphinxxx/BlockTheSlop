/**
 * Release verification gate (v7 RC cycle).
 *
 * Runs every acceptance gate IN ORDER against the CURRENT source and the
 * artifacts built by THIS run, then writes
 * `.agents/block-the-slop-v7/RELEASE_EVIDENCE.json` with:
 *   - the exact source tree fingerprint (see fingerprintRule),
 *   - per-gate command + exit code + duration,
 *   - actual unit test counts parsed from the Vitest run (never hardcoded),
 *   - browser versions used by the E2E run,
 *   - artifact hashes (build manifests, zips) — null hashes FAIL the run,
 *   - packaged-vs-tested byte equality proof,
 *   - evidence history (prior runs preserved, clearly distinguished).
 *
 * Ordering requirements (§7):
 *   - the Chrome artifact is built BEFORE browser tests, and the Chrome zip
 *     packages EXACTLY that tested build (byte-for-byte, verified), so
 *     "tested" and "shipped" are the same bytes;
 *   - generated-manifest validation runs against the freshly built manifests;
 *   - missing artifacts, hash mismatches, or nonzero required gates fail.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = join(root, '.agents', 'block-the-slop-v7');
const EVIDENCE_FILE = join(EVIDENCE_DIR, 'RELEASE_EVIDENCE.json');

/**
 * Gates in order. Notes:
 *  - `build` (chrome) runs BEFORE e2e:chromium-extension so browser tests load
 *    the artifact this run produced.
 *  - `verify:manifests` validates the GENERATED manifests in .output.
 *  - `zip` runs after the e2e suites; `verify:packaged-chrome` then proves the
 *    zip contains exactly the build the tests exercised.
 */
const gates = [
  { name: 'icons', cmd: 'npm run icons', required: true },
  { name: 'format:check', cmd: 'npm run format:check', required: true },
  { name: 'lint', cmd: 'npm run lint', required: true },
  { name: 'typecheck', cmd: 'npm run typecheck', required: true },
  { name: 'unit', cmd: 'npm test', required: true, parseTests: true },
  {
    name: 'test:artifact-integrity',
    cmd: 'node scripts/test-artifact-inventory.mjs',
    required: true,
  },
  { name: 'build', cmd: 'npm run build', required: true },
  {
    name: 'verify:manifest-chrome',
    cmd: 'node scripts/validate-manifest.mjs chrome-mv3 --target chrome',
    required: true,
  },
  {
    name: 'inventory:capture-chrome',
    cmd: 'node scripts/artifact-inventory.mjs capture chrome-mv3 chrome',
    required: true,
  },
  {
    name: 'e2e:chromium-extension',
    cmd: 'npx playwright test --project=chromium-extension',
    required: true,
    parseE2e: true,
  },
  {
    name: 'inventory:check-test-chrome',
    cmd: 'node scripts/artifact-inventory.mjs check-test chrome-mv3 chrome',
    required: true,
  },
  { name: 'build:firefox', cmd: 'npm run build:firefox', required: true },
  {
    name: 'verify:manifest-firefox',
    cmd: 'node scripts/validate-manifest.mjs firefox-mv2 --target firefox',
    required: true,
  },
  {
    name: 'inventory:capture-firefox',
    cmd: 'node scripts/artifact-inventory.mjs capture firefox-mv2 firefox',
    required: true,
  },
  {
    name: 'e2e:firefox-smoke',
    cmd: 'npx playwright test --project=firefox-smoke',
    required: true,
    parseE2e: true,
  },
  {
    name: 'inventory:check-test-firefox',
    cmd: 'node scripts/artifact-inventory.mjs check-test firefox-mv2 firefox',
    required: true,
  },
  { name: 'zip', cmd: 'npm run zip', required: true },
  {
    name: 'inventory:check-zip-chrome',
    cmd: 'node scripts/artifact-inventory.mjs check-zip block-the-slop-1.0.0-chrome.zip chrome-mv3 chrome',
    required: true,
  },
  { name: 'zip:firefox', cmd: 'npm run zip:firefox', required: true },
  {
    name: 'inventory:check-zip-firefox',
    cmd: 'node scripts/artifact-inventory.mjs check-zip block-the-slop-1.0.0-firefox.zip firefox-mv2 firefox',
    required: true,
  },
];

// ---- fingerprint: SHA-256 over sorted repo file names + contents ----------
// Keep EXCLUDED_DIRS in lockstep with scripts/fingerprint.mjs.
const EXCLUDED_DIRS = new Set([
  '.output',
  'node_modules',
  'test-results',
  'playwright-report',
  '.git',
  '.freebuff',
  '.agents',
  'archives',
  'block-the-slop-upgrade-agent-kit',
  'block-the-slop-next-loop-audit-kit',
  'block-the-slop-v4-loop-kit',
  'block-the-slop-v5-loop-kit',
  'block-the-slop-v6-loop-kit',
  'block-the-slop-v7',
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

/** Same rule as scripts/fingerprint.mjs — asserted before any gate runs. */
function fingerprintRuleDirsFromScript() {
  const script = readFileSync(join(root, 'scripts', 'fingerprint.mjs'), 'utf8');
  const match = /const EX = new Set\(\[([\s\S]*?)\]\);/.exec(script);
  if (match === null) return null;
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
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

/** Strip ANSI color escapes so summary lines are parseable. */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseVitestTotals(stdout, stderr) {
  const text = stripAnsi(`${stdout}\n${stderr}`);
  const files = /Test Files\s+(\d+) passed/.exec(text);
  const tests = /Tests\s+(\d+) passed/.exec(text);
  if (tests === null) return null;
  return { passed: Number(tests[1]), files: files === null ? null : Number(files[1]) };
}

function parsePlaywrightTotals(stdout, stderr) {
  const text = stripAnsi(`${stdout}\n${stderr}`);
  const passed = /(\d+) passed/.exec(text);
  if (passed === null) return null;
  const failed = /(\d+) failed/.exec(text);
  return {
    passed: Number(passed[1]),
    failed: failed === null ? 0 : Number(failed[1]),
  };
}

// ---- lockstep assertion: verify.mjs and fingerprint.mjs must exclude the
// same directories, or the recorded fingerprint describes a different tree.
{
  const verifyDirs = EXCLUDED_DIRS;
  const scriptDirs = fingerprintRuleDirsFromScript();
  if (scriptDirs === null) {
    process.stderr.write(
      '✗ cannot parse EX set from scripts/fingerprint.mjs (lockstep check broken)\n',
    );
    process.exit(1);
  }
  const onlyVerify = [...verifyDirs].filter((d) => !scriptDirs.has(d)).sort();
  const onlyScript = [...scriptDirs].filter((d) => !verifyDirs.has(d)).sort();
  if (onlyVerify.length > 0 || onlyScript.length > 0) {
    process.stderr.write(
      `✗ fingerprint exclusions out of lockstep — verify.mjs only: ${JSON.stringify(onlyVerify)}, fingerprint.mjs only: ${JSON.stringify(onlyScript)}\n`,
    );
    process.exit(1);
  }
  process.stdout.write('✓ fingerprint exclusions in lockstep with scripts/fingerprint.mjs\n');
}

// ---- gates -----------------------------------------------------------------
const gateResults = [];
let unitTotals = null;
let e2eChromiumTotals = null;
let e2eFirefoxTotals = null;
for (const gate of gates) {
  const started = Date.now();
  process.stdout.write(`\n=== GATE ${gate.name}: ${gate.cmd}\n`);
  const result = spawnSync(gate.cmd, {
    cwd: root,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  // Echo captured output (preserves the live log the user watches).
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const gateResult = {
    name: gate.name,
    cmd: gate.cmd,
    exit: result.status,
    durationMs,
    required: gate.required,
  };
  if (gate.parseTests) {
    const totals = parseVitestTotals(
      result.stdout?.toString() ?? '',
      result.stderr?.toString() ?? '',
    );
    if (totals !== null) {
      gateResult.tests = totals;
      unitTotals = totals;
    }
  }
  if (gate.parseE2e) {
    const totals = parsePlaywrightTotals(
      result.stdout?.toString() ?? '',
      result.stderr?.toString() ?? '',
    );
    if (totals !== null) {
      gateResult.tests = totals;
      if (gate.name === 'e2e:chromium-extension') e2eChromiumTotals = totals;
      if (gate.name === 'e2e:firefox-smoke') e2eFirefoxTotals = totals;
    }
  }
  gateResults.push(gateResult);
  if (result.status !== 0) {
    process.stderr.write(`\n✗ GATE FAILED: ${gate.name} (exit ${result.status})\n`);
    // Write partial evidence even on failure so the checker can see WHICH
    // gate failed and when (never silently stale).
    writeEvidence(gateResults, true, `gate ${gate.name} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`✓ ${gate.name}\n`);
}

function writeEvidence(gatesPassed, failed, failureNote) {
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
    schemaVersion: 7,
    runId: `verify-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    fingerprintRule:
      'SHA-256 over sorted repo file names + contents, excluding .output, node_modules, test-results, kit/evidence dirs, .git, .freebuff, .agents.',
    gates: gatesPassed,
    testTotals: {
      unitDomUi: unitTotals,
      e2eChromiumExtension: e2eChromiumTotals,
      e2eFirefoxSmoke: e2eFirefoxTotals,
      note: 'parsed from the gate output of THIS run; not hardcoded',
    },
    browsers: browserVersions(),
    testedBuildInventories: {
      chrome: 'inventory/tested-build-chrome.json',
      firefox: 'inventory/tested-build-firefox.json',
      note: 'Captured after build+manifest validation, verified unchanged after browser tests, and used as the comparison base for packaged zips (see scripts/artifact-inventory.mjs). Hashes recorded in artifacts plus per-file sha256 inside the inventory files.',
    },
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
  // Preserve evidence history: prior runs are kept (bounded) and clearly
  // distinguished; the live file always describes the LATEST run.
  try {
    const previousRaw = readFileSync(EVIDENCE_FILE, 'utf8');
    const previous = JSON.parse(previousRaw);
    if (previous?.runId && previous.runId !== evidence.runId) {
      const historyDir = join(EVIDENCE_DIR, 'history');
      mkdirSync(historyDir, { recursive: true });
      const stamp = previous.runId.replace(/^verify-/, '');
      writeFileSync(join(historyDir, `RELEASE_EVIDENCE-${stamp}.json`), previousRaw);
      const keep = readdirSync(historyDir)
        .filter((f) => f.startsWith('RELEASE_EVIDENCE-') && f.endsWith('.json'))
        .sort()
        .reverse();
      for (const old of keep.slice(20)) rmSync(join(historyDir, old));
    }
  } catch {
    // No prior evidence (or unreadable): nothing to preserve.
  }
  writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
}

writeEvidence(gateResults, false);
process.stdout.write(
  `\n✓ ALL GATES PASSED — evidence written to .agents/block-the-slop-v7/RELEASE_EVIDENCE.json\n`,
);
