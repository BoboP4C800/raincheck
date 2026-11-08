// Copies the website (the same files GitHub Pages serves) into www/, which Capacitor packages into the Android app.
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "www");
const files = ["index.html", "app.js", "base.css", "privacy.html", "icon.svg", "manifest.webmanifest", "sw.js", "designs", "fonts"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of files) cpSync(join(root, f), join(out, f), { recursive: true });
console.log(`www/ ready (${files.length} entries)`);
