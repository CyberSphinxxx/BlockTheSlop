/**
 * Synchronizes the extension PNG icons from the No-Slop-Play icon pack.
 *
 * Copies the official No Slop Play icons (16, 32, 48, 128 px)
 * from BlockTheSlop-NoSlopPlay-Icon-Pack into public/icon/.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const primaryPackDir = join(
  root,
  'archives',
  'design',
  'icon-pack',
  'BlockTheSlop-NoSlopPlay',
  'png',
  'chrome',
);
const fallbackPackDir = join(
  root,
  'BlockTheSlop-NoSlopPlay-Icon-Pack',
  'BlockTheSlop-NoSlopPlay',
  'png',
  'chrome',
);
const packDir = existsSync(primaryPackDir) ? primaryPackDir : fallbackPackDir;
const outDir = join(root, 'public', 'icon');

mkdirSync(outDir, { recursive: true });

const SIZES = [16, 32, 48, 128];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const size of SIZES) {
  const packFile = join(packDir, `icon${size}.png`);
  const outFile = join(outDir, `${size}.png`);

  if (existsSync(packFile)) {
    copyFileSync(packFile, outFile);
    console.log(`synced ${size}px icon from pack -> public/icon/${size}.png`);
  } else if (existsSync(outFile)) {
    const header = readFileSync(outFile).subarray(0, 8);
    if (!header.equals(PNG_MAGIC)) {
      console.error(`Invalid PNG at ${outFile}`);
      process.exit(1);
    }
    console.log(`verified existing valid icon at public/icon/${size}.png`);
  } else {
    console.error(`Missing icon for ${size}px: neither pack nor destination found`);
    process.exit(1);
  }
}
