---
name: commit-one-by-one
description: >-
  Commits uncommitted files to git one by one with unique, tailored conventional commit messages.
  Use this skill whenever the user asks to "commit this one by one to github", "commit one by one",
  "commit files individually", "commit each file separately", or create individual git commits for all uncommitted changes.
---

# SKILL: Commit Files One by One

Use this skill when the user requests committing changed and untracked files individually to git, each with its own tailored, descriptive commit message.

## Overview

Instead of bundling all changes into a single generic commit, this workflow breaks changes down into atomic, individual commits for each file. This maintains a rich, granular git commit history and allows surgical diff inspection.

> [!IMPORTANT]
> **Never run `git push` automatically.** The user explicitly runs `git push` themselves after reviewing the committed history.

---

## Workflow Steps

### Step 1: Inspect Uncommitted Files

Run `git status --porcelain -uall` to detect all modified, staged, untracked, and deleted files:

```powershell
git status --porcelain -uall
```

Count the total number of files. If the working tree is clean, inform the user that there is nothing to commit.

---

### Step 2: Execute Individual Commits

Run the dedicated repository script:

```powershell
node scripts/commit-individual-files.mjs
```

Or preview the planned commit messages first with dry-run:

```powershell
node scripts/commit-individual-files.mjs --dry-run
```

The script will:
1. Examine each file's path, directory, and `git diff` content.
2. Invert or infer the conventional commit type:
   - `feat(...)`: New features, components, services, or pages
   - `fix(...)`: Bug fixes, schedule reconciliations, or corrected presets
   - `perf(...)`: Performance optimizations (SSG, caching, package tree-shaking)
   - `refactor(...)`: Code reorganizations, cleanup, or architecture improvements
   - `style(...)`: CSS variables, Tailwind tokens, or theme color hints
   - `test(...)`: Unit, integration, or Playwright E2E test updates
   - `docs(...)`: Documentation, progress handoffs, or design artifacts
   - `chore(...)`: Tooling, scripts, configuration, or gitignore updates
3. Stage each file individually (`git add "<file>"`).
4. Commit with `--no-verify` (`git commit -m "<message>" --no-verify`) to prevent the pre-commit test hook from running redundantly for each individual file.
5. Print real-time progress: `[X/Y] ✅ (<hash>) <filepath> -> "<message>"`.

---

### Step 3: Present Completion Summary & Next Action

Once all files are committed:
1. Display the total number of commits created.
2. Run `git log -n <count> --oneline` to show the newly minted commits.
3. Inform the user that they can now push whenever they are ready by running:
   ```bash
   git push
   ```
