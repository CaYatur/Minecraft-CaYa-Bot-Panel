/**
 * Writes dist-electron/SHA256SUMS.txt for the Setup exe(s), in the format
 * `sha256sum -c` and `Get-FileHash` comparisons expect: "<hash>  <file>".
 * The file name is the one GitHub stores for the uploaded asset.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checksumLine } from "./release-assets.mjs";

const outDir = path.resolve(process.argv[2] || "dist-electron");
if (!fs.existsSync(outDir)) {
  console.error(`No ${outDir} folder; build first.`);
  process.exit(1);
}
const files = fs.readdirSync(outDir).filter((name) => /setup.*\.exe$/i.test(name));
if (!files.length) {
  console.error("No Setup .exe found to checksum.");
  process.exit(1);
}
const lines = files.map((name) => {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(outDir, name))).digest("hex");
  return checksumLine(hash, name);
});
fs.writeFileSync(path.join(outDir, "SHA256SUMS.txt"), lines.join("\n") + "\n", "utf8");
for (const line of lines) console.log(line);
