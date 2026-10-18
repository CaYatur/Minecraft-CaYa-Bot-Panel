/**
 * Confirms `npm run build` produced a server and a web panel.
 * Run this after the build. It does not start Minecraft.
 */
import * as fs from "fs";
import * as path from "path";

const root = process.cwd();
let failures = 0;
const ok = (name) => console.log(`  ok ${name}`);
const fail = (name) => {
  failures++;
  console.log(`  FAIL ${name}`);
};

const need = ["server/dist/index.js", "web/dist/index.html"];
for (const rel of need) {
  if (fs.existsSync(path.join(root, rel))) ok(rel);
  else fail(`${rel} is missing — run npm run build`);
}

const html = fs.existsSync(path.join(root, "web/dist/index.html"))
  ? fs.readFileSync(path.join(root, "web/dist/index.html"), "utf8")
  : "";
if (html.includes('id="root"') || html.includes("id='root'")) ok("web panel has a root node");
else fail("web panel html has no root node");

console.log(failures ? `\nFAILED ${failures}` : "\nbuild smoke passed");
process.exit(failures ? 1 : 0);
