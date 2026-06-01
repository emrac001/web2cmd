/**
 * Rasterize the SVG icons to PNGs for the PWA manifest + apple-touch-icon.
 *   node scripts/gen-icons.mjs
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pub = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

function render(svgFile, size, outFile) {
  const svg = readFileSync(join(pub, svgFile), "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(join(pub, outFile), png);
  console.log(`  ${outFile} (${size}x${size}, ${png.length} bytes)`);
}

console.log("[gen-icons] rendering PNGs...");
render("icon.svg", 192, "icon-192.png");
render("icon.svg", 512, "icon-512.png");
render("icon.svg", 180, "apple-touch-icon.png");
render("icon-maskable.svg", 512, "icon-maskable-512.png");
console.log("[gen-icons] done");
