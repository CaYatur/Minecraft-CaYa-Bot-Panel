/**
 * Writes dist-electron/SHA256SUMS.txt for the Setup exe(s), in the format
 * `sha256sum -c` and `Get-FileHash` comparisons expect: "<hash>  <file>".
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outDir = path.resolve(process.argv[2] || "dist-electron");
if (!fs.existsSync(outDir)) {
  console.error(`No ${outDir} folder; build first.`);
  process.exit(1);
}
const files = fs.readdirSync(outDir).filter((name) => name.toLowerCase().endsWith(".exe"));
if (!files.length) {
  console.error("No .exe found to checksum.");
  process.exit(1);
}
const lines = files.map((name) => {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(outDir, name))).digest("hex");
  return `${hash}  ${name}`;
});
fs.writeFileSync(path.join(outDir, "SHA256SUMS.txt"), lines.join("\n") + "\n", "utf8");
for (const line of lines) console.log(line);
