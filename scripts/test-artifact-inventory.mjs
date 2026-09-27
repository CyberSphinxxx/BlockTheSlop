/// Scenario tests for the artifact-integrity contract (RC2 issue 3).
///
/// Runs the REAL `scripts/artifact-inventory.mjs` CLI against an isolated
/// sandbox: the script is copied into <tmp>/scripts/, so its repo-root
/// resolution points inside <tmp> — the real release artifacts are never
/// touched. Exits nonzero on the first failed scenario.
///
/// Run: node scripts/test-artifact-inventory.mjs   (also a verify gate)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = join(repoRoot, 'scripts', 'artifact-inventory.mjs');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const sandbox = mkdtempSync(join(tmpdir(), 'rc2-inv-scenarios-'));
const root = join(sandbox, 'repo');
const agentsDir = join(root, '.agents', 'block-the-slop-v7', 'inventory');
const buildDir = join(root, '.output', 'chrome-mv3');
mkdirSync(agentsDir, { recursive: true });
mkdirSync(join(buildDir, 'icon'), { recursive: true });
mkdirSync(join(root, 'scripts'), { recursive: true });
cpSync(scriptSource, join(root, 'scripts', 'artifact-inventory.mjs'));

const manifest = Buffer.from('{"name":"blocktheslop","version":"1.0.0"}');
const icon = Buffer.from([9, 9, 9]);
writeFileSync(join(buildDir, 'manifest.json'), manifest);
writeFileSync(join(buildDir, 'icon', '16.png'), icon);

function run(args) {
  const res = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'artifact-inventory.mjs'), ...args],
    {
      encoding: 'utf8',
    },
  );
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** Minimal STORE-method zip builder (pure Node, deterministic fixtures). */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, content);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(content.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + content.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

let failures = 0;
function scenario(name, fn) {
  const started = Date.now();
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(
        () => console.log(`  ✓ ${name}`),
        (error) => {
          failures += 1;
          console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : error}`);
        },
      );
      return;
    }
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : error}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---- capture ---------------------------------------------------------------
const captureOut = run(['capture', 'chrome-mv3', 'chrome']);
expect(captureOut.code === 0, `capture failed: ${captureOut.out}`);
const invPath = join(agentsDir, 'tested-build-chrome.json');
expect(existsSync(invPath), 'inventory file written');
const inv = JSON.parse(readFileSync(invPath, 'utf8'));
expect(inv.fileCount === 2, `inventory has 2 files (got ${inv.fileCount})`);

// ---- check-test ------------------------------------------------------------
scenario('check-test passes on an unchanged build', () => {
  const res = run(['check-test', 'chrome-mv3', 'chrome']);
  expect(res.code === 0, res.out);
});

scenario('check-test FAILS when a tested file changes after capture', () => {
  writeFileSync(join(buildDir, 'manifest.json'), Buffer.from('{"tampered":true}'));
  const res = run(['check-test', 'chrome-mv3', 'chrome']);
  expect(res.code !== 0, 'must fail');
  expect(res.out.includes('CHANGED'), `must report CHANGED: ${res.out}`);
  // restore for later scenarios
  writeFileSync(join(buildDir, 'manifest.json'), manifest);
});

scenario('check-test FAILS on a missing file', () => {
  rmSync(join(buildDir, 'icon', '16.png'));
  const res = run(['check-test', 'chrome-mv3', 'chrome']);
  expect(res.code !== 0, 'must fail');
  expect(res.out.includes('MISSING'), res.out);
  writeFileSync(join(buildDir, 'icon', '16.png'), icon);
});

scenario('check-test FAILS on an extra file', () => {
  writeFileSync(join(buildDir, 'extra.txt'), Buffer.from('extra'));
  const res = run(['check-test', 'chrome-mv3', 'chrome']);
  expect(res.code !== 0, 'must fail');
  expect(res.out.includes('EXTRA'), res.out);
  rmSync(join(buildDir, 'extra.txt'));
});

scenario('check-test FAILS when the inventory is missing', () => {
  rmSync(invPath);
  const res = run(['check-test', 'chrome-mv3', 'chrome']);
  expect(res.code !== 0, 'must fail');
  expect(res.out.includes('missing inventory'), res.out);
  run(['capture', 'chrome-mv3', 'chrome']); // re-capture for zip scenarios
});

// ---- check-zip -------------------------------------------------------------
const zipPath = join(root, '.output', 'test.zip');

scenario('check-zip passes on an identical zip', () => {
  writeFileSync(
    zipPath,
    buildZip([
      ['manifest.json', manifest],
      ['icon/16.png', icon],
    ]),
  );
  const res = run(['check-zip', 'test.zip', 'chrome-mv3', 'chrome']);
  expect(res.code === 0, res.out);
});

scenario('check-zip FAILS on a changed file (rebuild-gap scenario)', () => {
  // Rebuilt output and rebuilt zip AGREE with each other but differ from the
  // tested inventory — this is exactly the gap the inventory closes.
  const tamperedManifest = Buffer.from('{"rebuilt":true}');
  writeFileSync(join(buildDir, 'manifest.json'), tamperedManifest);
  writeFileSync(
    zipPath,
    buildZip([
      ['manifest.json', tamperedManifest],
      ['icon/16.png', icon],
    ]),
  );
  const res = run(['check-zip', 'test.zip', 'chrome-mv3', 'chrome']);
  expect(res.code !== 0, `must fail against the preserved inventory: ${res.out}`);
  expect(res.out.includes('CHANGED'), res.out);
  writeFileSync(join(buildDir, 'manifest.json'), manifest);
});

scenario('check-zip FAILS on a missing file', () => {
  writeFileSync(zipPath, buildZip([['manifest.json', manifest]]));
  const res = run(['check-zip', 'test.zip', 'chrome-mv3', 'chrome']);
  expect(res.code !== 0, 'must fail');
  expect(res.out.includes('MISSING'), res.out);
});

scenario('check-zip FAILS on an extra file', () => {
  writeFileSync(
    zipPath,
    buildZip([
      ['manifest.json', manifest],
      ['icon/16.png', icon],
      ['extra.txt', Buffer.from('x')],
    ]),
  );
  const res = run(['check-zip', 'test.zip', 'chrome-mv3', 'chrome']);
  expect(res.code !== 0, 'must fail');
  expect(res.out.includes('EXTRA'), res.out);
});

scenario('check-zip FAILS on a wrong-target inventory', () => {
  writeFileSync(
    zipPath,
    buildZip([
      ['manifest.json', manifest],
      ['icon/16.png', icon],
    ]),
  );
  // Firefox inventory exists but describes different content semantics:
  const res = run(['check-zip', 'test.zip', 'chrome-mv3', 'firefox']);
  expect(res.code !== 0, 'firefox inventory must not match chrome build content');
  expect(
    res.out.includes('missing inventory') ||
      res.out.includes('CHANGED') ||
      res.out.includes('MISSING') ||
      res.out.includes('EXTRA'),
    res.out,
  );
});

scenario('check-zip FAILS on a missing inventory', () => {
  rmSync(invPath);
  const res = run(['check-zip', 'test.zip', 'chrome-mv3', 'chrome']);
  expect(res.code !== 0, 'must fail');
  expect(res.out.includes('missing inventory'), res.out);
});

scenario('zip reader rejects traversal, absolute, backslash, duplicates', async () => {
  // Import the sandbox copy of the tool to exercise the same reader the CLI
  // runs. On Windows file URLs need forward slashes and a leading slash.
  const sandboxScriptPath = join(root, 'scripts', 'artifact-inventory.mjs').split('\\').join('/');
  const mod = await import(`file:///${sandboxScriptPath.replace(/^\//, '')}`);
  const evil = Buffer.from('evil');
  const traversal = buildZip([['../evil.js', evil]]);
  expect(mod.readZipEntries(traversal).problems.join(' ').includes('unsafe entry'), 'traversal');
  const absolute = buildZip([['/abs/evil.js', evil]]);
  expect(mod.readZipEntries(absolute).problems.join(' ').includes('unsafe entry'), 'absolute');
  const backslash = buildZip([['dir\\evil.js', evil]]);
  expect(mod.readZipEntries(backslash).problems.join(' ').includes('backslash'), 'backslash');
  const dup = buildZip([
    ['a.js', Buffer.from('1')],
    ['a.js', Buffer.from('2')],
  ]);
  expect(mod.readZipEntries(dup).problems.join(' ').includes('duplicate entry'), 'duplicate');
});

setTimeout(() => {
  rmSync(sandbox, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n✗ ${failures} artifact-integrity scenario(s) FAILED`);
    process.exit(1);
  }
  console.log('\n✓ all artifact-integrity scenarios passed');
  process.exit(failures > 0 ? 1 : 0);
}, 500);
