---
name: create-github-tag
description: >-
  Create a Git release tag and generate comprehensive release notes formatted in raw markdown without any emojis or emdashes. Use this skill when the user chats "create github tag v.#.#.#" or asks to tag a release version and generate release notes.
---

# Create GitHub Tag and Release Notes Skill

This skill guides the automated process of tagging a release in Git, triggering release asset compilation via CI/CD, and delivering detailed release notes in the conversation chat.

## Constraints

- Release notes MUST be output in raw markdown.
- Release notes MUST NOT contain any emoji characters.
- Release notes MUST NOT contain any emdash characters (do not use "—" or "--" as an emdash; use hyphens "-", colons, or parentheses).
- Always verify working tree status before tagging.

## Workflow Steps

### 1. Extract and Validate Tag Name

Parse the version tag requested by the user (for example `v1.0.0`). The tag must follow the pattern `v[0-9]+\.[0-9]+\.[0-9]+` (with optional pre-release suffix).

### 2. Verify Repository State

Run:

```bash
git status
```

Ensure the working tree is clean or help the user commit required changes before tagging.
Check existing tags:

```bash
git tag -l <tag_name>
```

If the tag already exists, alert the user before proceeding or overwriting.

### 3. Create the Git Tag

Create an annotated git tag:

```bash
git tag -a <tag_name> -m "Release <tag_name>"
```

Notify the user that pushing the tag will trigger the GitHub Actions release workflow:

```bash
git push origin <tag_name>
```

Once pushed, `.github/workflows/release.yml` will run all tests, build the Chrome and Firefox extensions, package the zip archives, and attach `block-the-slop-*-chrome.zip` and `block-the-slop-*-firefox.zip` directly to the GitHub Release.

### 4. Generate Comprehensive Release Notes in Chat

Inspect recent git history (`git log`) and feature documents to compose complete release notes for the version.

Present the release notes directly in the conversation in a raw markdown code block or plain markdown according to the constraints:

- Strictly no emojis.
- Strictly no emdashes (replace any emdash with a standard hyphen `-`).
- Sections should cover:
  - Overview of the version.
  - Highlights and key capabilities.
  - Core architecture and privacy guarantees.
  - Detection and classification system.
  - User controls and surface coverage.
  - Packaging and installation instructions (attaching/loading Chrome MV3 and Firefox).
  - Test and verification summary.
