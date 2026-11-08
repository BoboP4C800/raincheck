// Draws the source images @capacitor/assets turns into Android launcher icons and splash screens.
// The artwork is the same rain-curve mark as icon.svg. Run: node scripts/make-icon-sources.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
mkdirSync(out, { recursive: true });

const BG = "#0C141B", RAIN = "#5AA2FF", DOT = "#E6EDF2";
// The mark, drawn in a 512 box (from icon.svg), centered on 256,285.
const mark = `
  <path d="M96 336 C150 336 170 250 216 250 C262 250 270 190 316 190 C362 190 380 300 416 300 L416 380 L96 380 Z" fill="${RAIN}" fill-opacity=".35"/>
  <path d="M96 336 C150 336 170 250 216 250 C262 250 270 190 316 190 C362 190 380 300 416 300" fill="none" stroke="${RAIN}" stroke-width="22" stroke-linecap="round"/>
  <circle cx="96" cy="336" r="20" fill="${DOT}"/>`;
// Place the mark centered in a square of `size`, scaled so it is `frac` of the width.
const placed = (size, frac) => {
  const s = (size * frac) / 340;           // mark is ~340 units wide (86..426)
  const tx = size / 2 - 256 * s, ty = size / 2 - 285 * s;
  return `<g transform="translate(${tx} ${ty}) scale(${s})">${mark}</g>`;
};
const svg = (size, body, bg) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ""}${body}</svg>`);

const jobs = [
  ["icon-only.png", 1024, placed(1024, 0.66), BG],          // legacy square icon
  ["icon-foreground.png", 1024, placed(1024, 0.5), null],   // adaptive foreground: inside the 66% safe zone
  ["icon-background.png", 1024, "", BG],                    // adaptive background
  ["splash.png", 2732, placed(2732, 0.22), BG],
  ["splash-dark.png", 2732, placed(2732, 0.22), BG],
];
for (const [name, size, body, bg] of jobs) {
  await sharp(svg(size, body, bg)).png().toFile(join(out, name));
  console.log("wrote assets/" + name);
}
