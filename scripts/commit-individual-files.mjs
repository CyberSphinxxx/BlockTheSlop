import { execSync } from 'child_process';
import path from 'path';

const isDryRun = process.argv.includes('--dry-run');

function getUncommittedFiles() {
  const output = execSync('git status --porcelain -uall', { encoding: 'utf-8' });
  const lines = output.split(/\r?\n/).filter(Boolean);
  const files = [];

  for (const line of lines) {
    // status is first 2 chars, then space, then filename
    const filePath = line.slice(3).trim().replace(/^"|"$/g, '');
    if (filePath) {
      files.push(filePath);
    }
  }
  return files;
}

function inferCommitMessage(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  let baseName = path.basename(normalized, path.extname(normalized));
  baseName = baseName.replace(/\.(test|spec)$/, '');
  const ext = path.extname(normalized);

  // Config & Root Tooling
  if (normalized === '.gitignore') return 'chore(git): update gitignore to exclude build artifacts, agent kits, and archives';
  if (normalized === '.prettierrc.json') return 'chore(style): configure prettier code formatting rules';
  if (normalized === 'eslint.config.js') return 'chore(lint): configure eslint rules and typescript parser';
  if (normalized === 'tsconfig.json') return 'chore(typescript): configure compiler options and strict typechecking';
  if (normalized === 'package.json') return 'chore(deps): define package manifest and npm script workflows';
  if (normalized === 'package-lock.json') return 'chore(deps): lock deterministic npm dependency tree';
  if (normalized === 'playwright.config.ts') return 'test(e2e): configure playwright test runner and browser profiles';
  if (normalized === 'vitest.config.ts') return 'test(unit): configure vitest test framework and environment';
  if (normalized === 'wxt.config.ts') return 'chore(build): configure wxt framework build targets and manifest options';

  // Documentation & Project metadata
  if (normalized === 'README.md') return 'docs: expand readme with architecture, installation, and privacy specifications';
  if (normalized === 'LICENSE') return 'docs(license): add MIT license agreement';
  if (normalized === 'AGENTS.md') return 'docs: document agent engineering contract and verification boundaries';
  if (normalized === 'TASKS.md') return 'docs: record comprehensive implementation task ledger and historical checklist';
  if (normalized.startsWith('skills/')) {
    const skillName = normalized.split('/')[1];
    return `docs(skill): add ${skillName} skill instructions and workflow definition`;
  }

  // CI & Scripts
  if (normalized.startsWith('.github/workflows/')) return `ci(workflow): add ${baseName} automated github actions workflow`;
  if (normalized === 'scripts/generate-icons.mjs') return 'chore(scripts): add script for dynamic extension icon generation';
  if (normalized === 'scripts/verify.mjs') return 'chore(scripts): implement release verification and gate validation script';
  if (normalized === 'scripts/commit-individual-files.mjs') return 'chore(scripts): add automated one-by-one git commit runner script';

  // Assets
  if (normalized.startsWith('public/icon/')) return `assets(icons): add ${baseName}x${baseName} application icon asset`;

  // Domain layer
  if (normalized.startsWith('src/domain/')) return `feat(domain): implement ${baseName} domain models and type contracts`;
  if (normalized.startsWith('src/shared/')) return `feat(shared): implement ${baseName} shared utility module`;

  // Storage layer
  if (normalized.startsWith('src/storage/')) return `feat(storage): implement ${baseName} persistence layer module`;

  // Detection layer
  if (normalized.startsWith('src/detection/detectors/')) return `feat(detection): implement ${baseName} slop detector`;
  if (normalized.startsWith('src/detection/rules/')) return `feat(detection): add ${baseName} keyword rules and phrase definitions`;
  if (normalized.startsWith('src/detection/')) return `feat(detection): implement ${baseName} detection pipeline engine`;

  // Policy & Decision
  if (normalized.startsWith('src/policy/')) return `feat(policy): implement ${baseName} user preference and rule evaluation logic`;

  // Presentation & DOM manipulation
  if (normalized.startsWith('src/presentation/')) return `feat(presentation): implement ${baseName} overlay and dom update handler`;

  // YouTube DOM Parsing & Scraping
  if (normalized.startsWith('src/youtube/parse/')) return `feat(youtube): implement ${baseName} candidate dom card parser`;
  if (normalized.startsWith('src/youtube/')) return `feat(youtube): implement ${baseName} dom observer and navigation handler`;

  // Pipeline & Background
  if (normalized.startsWith('src/pipeline/')) return `feat(pipeline): implement ${baseName} batch processing orchestrator`;
  if (normalized.startsWith('src/background/')) return `feat(background): implement ${baseName} service worker message routing`;
  if (normalized.startsWith('src/diagnostics/')) return `feat(diagnostics): implement ${baseName} diagnostic and support export`;
  if (normalized.startsWith('src/import-export/')) return `feat(import-export): implement ${baseName} configuration transfer schema`;
  if (normalized.startsWith('src/providers/')) return `feat(providers): implement ${baseName} reputation provider client`;

  // UI & Entrypoints
  if (normalized.startsWith('src/ui/components/')) return `feat(ui): implement reusable ${baseName} component`;
  if (normalized === 'src/ui/tailwind.css') return 'style(ui): define tailwind css design tokens and custom styles';
  if (normalized.startsWith('src/ui/')) return `feat(ui): implement ${baseName} user interface module`;
  if (normalized === 'src/entrypoints/youtube.content/style.css') return 'style(youtube): add content script overlay and badge styling';
  if (normalized.startsWith('src/entrypoints/youtube.content/')) return `feat(youtube-content): implement content script entrypoint logic`;
  if (normalized.startsWith('src/entrypoints/popup/')) return `feat(popup): implement extension popup ui ${baseName}`;
  if (normalized.startsWith('src/entrypoints/options/')) return `feat(options): implement settings options ui ${baseName}`;
  if (normalized.startsWith('src/entrypoints/')) return `feat(entrypoints): implement ${baseName} extension entrypoint`;

  // Tests
  if (normalized.startsWith('tests/dom/')) return `test(dom): add dom integration test for ${baseName}`;
  if (normalized.startsWith('tests/e2e/fixtures/')) return `test(e2e-fixtures): add mock youtube page fixture ${baseName}`;
  if (normalized.startsWith('tests/e2e/')) return `test(e2e): add end-to-end test suite for ${baseName}`;
  if (normalized.startsWith('tests/perf/')) return `test(perf): add performance benchmark test for ${baseName}`;
  if (normalized.startsWith('tests/storage/')) return `test(storage): add storage integration test for ${baseName}`;
  if (normalized.startsWith('tests/ui/')) return `test(ui): add ui test suite for ${baseName}`;
  if (normalized.startsWith('tests/unit/')) return `test(unit): add unit test coverage for ${baseName}`;
  if (normalized.startsWith('tests/fixtures/')) return `test(fixtures): add ${baseName} fixture data`;
  if (normalized.startsWith('tests/')) return `test: configure test harness ${baseName}`;

  // Default fallback
  const category = normalized.includes('/') ? normalized.split('/')[0] : 'root';
  return `chore(${category}): add ${baseName}${ext}`;
}

function run() {
  const files = getUncommittedFiles();
  const total = files.length;

  if (total === 0) {
    console.log('Working tree is clean. Nothing to commit.');
    return;
  }

  console.log(`Found ${total} uncommitted file(s).`);

  let count = 0;
  for (const file of files) {
    count++;
    const message = inferCommitMessage(file);
    if (isDryRun) {
      console.log(`[${count}/${total}] 🔍 (dry-run) ${file} -> "${message}"`);
      continue;
    }

    try {
      execSync(`git add "${file}"`, { stdio: 'pipe' });
      execSync(`git commit -m "${message}" --no-verify`, { stdio: 'pipe' });
      const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
      console.log(`[${count}/${total}] ✅ (${hash}) ${file} -> "${message}"`);
    } catch (err) {
      console.error(`[${count}/${total}] ❌ Failed to commit ${file}:`, err.message);
      process.exit(1);
    }
  }

  console.log(`\n🎉 Successfully created ${count} commits.`);
}

run();
