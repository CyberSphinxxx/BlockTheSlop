/**
 * Generated-manifest validator (release blocker A).
 *
 * Validates the BUILT manifest in `.output/<outDir>` — not `wxt.config.ts` —
 * because the store reviews the generated artifact. Checks:
 *   - description length (Chrome documents a 132-character maximum),
 *   - name length (Chrome Web Store documents a 75-character maximum),
 *   - required name/version fields and a well-formed version,
 *   - every referenced icon / script / HTML page / service worker exists,
 *   - exact permission + host-permission allowlists (nothing extra sneaks in),
 *   - Firefox-only browser_specific_settings appear ONLY in firefox targets,
 *   - no development-only entry points (wxt:reload-extension command),
 *   - no source-map references,
 *   - no emitted .map files in the output directory.
 *
 * Usage:
 *   node scripts/validate-manifest.mjs chrome-mv3  --target chrome
 *   node scripts/validate-manifest.mjs firefox-mv2 --target firefox
 *
 * Exits nonzero with a list of violations. Sources for the limits:
 *   - https://developer.chrome.com/docs/extensions/reference/manifest
 *     ("description": maximum length is 132 characters) — verified 2026-09-27.
 *   - https://developer.chrome.com/docs/extensions/whats-new (75-character
 *     universal store limit for the manifest "name") — verified 2026-09-27.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Chrome manifest "description" maximum (developer.chrome.com, verified 2026-09-27). */
export const DESCRIPTION_MAX = 132;
/** Chrome Web Store manifest "name" maximum (developer.chrome.com, verified 2026-09-27). */
export const NAME_MAX = 75;

/** Product allowlist: v1 filters only — no extra APIs without a shipped feature. */
const PERMISSIONS_BY_TARGET = {
  chrome: ['storage', 'contextMenus'],
  firefox: ['storage', 'contextMenus', '*://*.youtube.com/*'], // MV2 merges host permissions here
};
const HOST_PERMISSIONS_BY_TARGET = {
  chrome: ['*://*.youtube.com/*'],
  firefox: [],
};

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Expand a manifest glob like "icon/*.png" against the files under `outDir`. */
function expandGlob(pattern, outDir) {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')}$`,
  );
  return listFiles(outDir)
    .map((p) =>
      p
        .split('\\')
        .join('/')
        .slice(outDir.split('\\').join('/').length + 1),
    )
    .filter((rel) => regex.test(rel));
}

function globMatchesSomeFile(pattern, outDir) {
  if (!pattern.includes('*')) return existsSync(join(outDir, pattern));
  return expandGlob(pattern, outDir).length > 0;
}

/** Validate a manifest object against the target contract. Returns violations. */
export function validateManifestObject(manifest, target) {
  const errors = [];
  const add = (msg) => errors.push(msg);

  // ---- required fields ----
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    add("manifest 'name' must be a non-empty string");
  } else if (manifest.name.length > NAME_MAX) {
    add(`manifest 'name' is ${manifest.name.length} chars (store limit ${NAME_MAX})`);
  }
  if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
    add("manifest 'description' must be a non-empty string");
  } else if (manifest.description.length > DESCRIPTION_MAX) {
    add(
      `manifest 'description' is ${manifest.description.length} chars (Chrome limit ${DESCRIPTION_MAX}): "${manifest.description}"`,
    );
  }
  if (typeof manifest.version !== 'string' || !/^\d+(\.\d+){1,3}$/.test(manifest.version)) {
    add(
      `manifest 'version' must be a well-formed X.Y[.Z] string, got ${JSON.stringify(manifest.version)}`,
    );
  }

  // ---- permissions: exact allowlist, nothing extra ----
  const expectedPerms = PERMISSIONS_BY_TARGET[target];
  const perms = [...(manifest.permissions ?? [])].sort();
  if (JSON.stringify(perms) !== JSON.stringify([...expectedPerms].sort())) {
    add(
      `permissions must be exactly ${JSON.stringify(expectedPerms.sort())}, got ${JSON.stringify(perms)}`,
    );
  }
  const expectedHosts = HOST_PERMISSIONS_BY_TARGET[target];
  const hosts = [...(manifest.host_permissions ?? [])].sort();
  if (JSON.stringify(hosts) !== JSON.stringify([...expectedHosts].sort())) {
    add(
      `host_permissions must be exactly ${JSON.stringify([...expectedHosts].sort())}, got ${JSON.stringify(hosts)}`,
    );
  }

  // ---- content scripts may only match YouTube ----
  for (const cs of manifest.content_scripts ?? []) {
    for (const pattern of cs.matches ?? []) {
      if (!/:\/\/(\*\.)?youtube\.com\//.test(pattern)) {
        add(`content_scripts match ${JSON.stringify(pattern)} is outside youtube.com`);
      }
    }
    if ((cs.js ?? []).length === 0 && (cs.css ?? []).length === 0) {
      add('content_scripts entry has neither js nor css');
    }
  }

  // ---- Firefox-only fields are handled intentionally by target ----
  const bss = manifest.browser_specific_settings;
  if (target === 'chrome') {
    if (manifest.manifest_version !== 3) {
      add(`chrome target must emit manifest_version 3, got ${manifest.manifest_version}`);
    }
    if (bss !== undefined) {
      add(
        `browser_specific_settings (${JSON.stringify(bss)}) is Firefox-only and must NOT appear in the Chrome build`,
      );
    }
    const worker = manifest.background?.service_worker;
    if (typeof worker !== 'string' || worker.length === 0) {
      add('chrome MV3 requires background.service_worker');
    }
    if (typeof manifest.action?.default_popup !== 'string') {
      add('chrome MV3 requires action.default_popup');
    }
  } else if (target === 'firefox') {
    if (manifest.manifest_version !== 2) {
      add(`firefox target must emit manifest_version 2, got ${manifest.manifest_version}`);
    }
    if (bss?.gecko?.id !== 'blocktheslop@local') {
      add("firefox build must keep browser_specific_settings.gecko.id 'blocktheslop@local'");
    }
    if (typeof bss?.gecko?.strict_min_version !== 'string') {
      add('firefox build must keep browser_specific_settings.gecko.strict_min_version');
    }
    if (!(manifest.background?.scripts ?? []).some((s) => typeof s === 'string')) {
      add('firefox MV2 requires background.scripts');
    }
    if (typeof manifest.browser_action?.default_popup !== 'string') {
      add('firefox MV2 requires browser_action.default_popup');
    }
  } else {
    add(`unknown target ${JSON.stringify(target)}`);
  }

  // ---- no development-only entry points / source maps ----
  if (manifest.commands?.['wxt:reload-extension'] !== undefined) {
    add("development-only command 'wxt:reload-extension' must not ship");
  }
  const manifestJson = JSON.stringify(manifest);
  if (manifestJson.includes('.map')) {
    add('manifest references a source map');
  }

  return errors;
}

/** Validate the manifest + referenced files that exist on disk in `outDirName`. */
export function validateOutDir(outDirName, target) {
  const outDir = join(root, '.output', outDirName);
  const errors = [];
  const manifestPath = join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      errors: [
        `missing generated manifest: .output/${outDirName}/manifest.json (run the build first)`,
      ],
    };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  errors.push(...validateManifestObject(manifest, target));

  // ---- every referenced file must exist ----
  const refs = [];
  const icons = manifest.icons ?? {};
  for (const [size, path] of Object.entries(icons)) {
    if (!['16', '32', '48', '128'].includes(size)) errors.push(`unexpected icon size ${size}`);
    refs.push([`icons[${size}]`, path]);
  }
  if (manifest.background?.service_worker)
    refs.push(['background.service_worker', manifest.background.service_worker]);
  for (const s of manifest.background?.scripts ?? []) refs.push(['background.scripts', s]);
  if (manifest.action?.default_popup)
    refs.push(['action.default_popup', manifest.action.default_popup]);
  if (manifest.browser_action?.default_popup)
    refs.push(['browser_action.default_popup', manifest.browser_action.default_popup]);
  if (manifest.options_ui?.page) refs.push(['options_ui.page', manifest.options_ui.page]);
  for (const [i, cs] of (manifest.content_scripts ?? []).entries()) {
    for (const s of cs.js ?? []) refs.push([`content_scripts[${i}].js`, s]);
    for (const s of cs.css ?? []) refs.push([`content_scripts[${i}].css`, s]);
  }
  const war = manifest.web_accessible_resources ?? [];
  const warResources = typeof war[0] === 'object' ? war.flatMap((w) => w.resources ?? []) : war; // MV2 form: flat array of globs
  for (const r of warResources) refs.push(['web_accessible_resources', r]);
  for (const [what, path] of refs) {
    if (!globMatchesSomeFile(path, outDir)) {
      errors.push(`manifest ${what} references missing file: ${path}`);
    }
  }

  // ---- no source maps or dev leftovers emitted next to the manifest ----
  for (const file of listFiles(outDir)) {
    const base = file.split('\\').join('/').split('/').pop() ?? '';
    if (base.endsWith('.map')) errors.push(`source map shipped in build output: ${base}`);
  }

  return { ok: errors.length === 0, errors, manifest };
}

// ---- CLI ----------------------------------------------------------------
const argv = process.argv.slice(2);
const outDirName = argv[0];
const targetIdx = argv.indexOf('--target');
const target = targetIdx !== -1 ? argv[targetIdx + 1] : undefined;
if (!outDirName || !target) {
  console.error('usage: node scripts/validate-manifest.mjs <outDirName> --target <chrome|firefox>');
  process.exit(2);
}
const result = validateOutDir(outDirName, target);
if (!result.ok) {
  console.error(`✗ manifest validation FAILED for .output/${outDirName} (${target}):`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `✓ .output/${outDirName} (${target}): description ${result.manifest.description.length}/${DESCRIPTION_MAX}, ` +
    `name ${result.manifest.name.length}/${NAME_MAX}, permissions ${JSON.stringify(result.manifest.permissions)}` +
    `${target === 'chrome' ? ', no Firefox-only fields' : ', gecko id present'}, all referenced files exist`,
);
