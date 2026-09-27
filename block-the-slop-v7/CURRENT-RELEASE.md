# BlockTheSlop V7 — current checkout release

The older `V7-FINAL-REPORT.md` and `RELEASE_EVIDENCE.json` in this directory describe the run on the other PC. Their source fingerprint and ZIP hashes do **not** identify the current checkout. Use the files in `current/` for this checkout.

## Verified current build

- Source fingerprint: `96ec304ee1c648e69a60deb23b4f0acc790a9aae07f5c65bf96410e9a6fcac0c`
- Verification run: `verify-2026-09-27T19-59-32-672Z`
- All **20/20** required gates passed in one run: format, lint, typecheck, **896/896** unit/DOM/UI tests, Chrome build and manifest validation, **55/55** loaded-extension Chromium E2E tests, Firefox build and **2/2** smoke tests, and byte-for-byte tested-build-to-ZIP checks for both targets.
- A separate live YouTube probe of this built Chrome extension passed **6/6** checks, including zero-size hidden cards, a restore that survived rescan, and no extension UI overlapping the player. See `current/live-probe-evidence.json`.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `current/block-the-slop-1.0.0-chrome.zip` | 166,626 bytes | `ab507e85c3bc298f551dd5eba7b8212dc6387570abd6e0be5c419a1dcd5b2e2a` |
| `current/block-the-slop-1.0.0-firefox.zip` | 166,659 bytes | `3563356b5225fc929bf4ab75a37e63a7783ffc12691503e2a0e5dfa108979afd` |

The ZIPs in `current/` are copies of the generated `.output/` ZIPs. Compare hashes before upload. The evidence and captured build inventories are also copied into `current/` so the record remains available when ignored `.agents/` and `.output/` folders are absent on another PC.

## Scope and limits

The V7 implementation commits are already on `main`. This checkout also has two release-process changes: the copied evidence directory is excluded from source fingerprint and formatting checks, and `.gitattributes` keeps text files at LF so Windows checkouts pass the same format gate. Formatting normalized the eight V7 source/test files without changing their Git-normalized contents.

The Chrome ZIP above is the one to use for Chrome Web Store submission from this checkout. The old `f0f5f124…` ZIP hash in `V7-FINAL-REPORT.md` belongs to the other PC's run. Firefox extension runtime and detector accuracy remain unverified; the Firefox smoke checks cover build integrity and browser launch only. Store approval and listing requirements remain owner actions.
