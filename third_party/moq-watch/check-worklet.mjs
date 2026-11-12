// Extract the patched worklet body and syntax-check it with new Function.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const file = readFileSync(
  join(here, "..", "..", "client", "node_modules", "@moq/watch", "player-B6mw85kT.js"),
  "utf8",
);
const m = file.match(/new Blob\(\["([\s\S]*?)"\], \{ type: "application\/javascript" \}\)/);
if (!m) {
  console.error("blob not found");
  process.exit(1);
}
const worklet = JSON.parse(
  `"${m[1].replace(/[\x00-\x1f]/g, (c) =>
    c === "\t" ? "\\t" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}"`,
);
// Parse-check without executing: wrap so class fields / private fields are
// valid, and provide the globals the body references at top level.
const src = worklet;
try {
  new Function(src);
  console.log("worklet parses OK, length", src.length);
} catch (e) {
  console.error("worklet parse FAILED:", e.message);
  // Dump to a file for inspection
  writeFileSync(join(here, "worklet-dump.js"), src);
  process.exit(1);
}
console.log("catch-up markers:", (src.match(/campfire catch-up/g) || []).length);
