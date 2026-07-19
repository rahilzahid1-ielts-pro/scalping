/**
 * Generate PWA icon PNGs from assets/icon.svg into public/.
 * Run once (or whenever branding changes):  node scripts/gen-icons.mjs
 * Requires the `sharp` devDependency.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "assets", "icon.svg");
const OUT = join(ROOT, "public");

const svg = readFileSync(SRC);

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
  { file: "favicon-32.png", size: 32 },
];

for (const t of targets) {
  await sharp(svg, { density: 384 })
    .resize(t.size, t.size, { fit: "cover" })
    .png()
    .toFile(join(OUT, t.file));
  console.log("wrote", t.file, `(${t.size}x${t.size})`);
}

console.log("done — icons in public/");
