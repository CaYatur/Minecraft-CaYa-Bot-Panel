import fs from "node:fs";
import path from "node:path";

const TR = /[\u00e7\u011f\u0131\u00f6\u015f\u00fc\u00c7\u011e\u0130\u00d6\u015e\u00dc]/;
const root = path.resolve(import.meta.dirname, "..", "server", "src");

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

const set = new Set();
for (const f of walk(root)) {
  const s = fs.readFileSync(f, "utf8");
  // simple quoted strings (not full template parse)
  for (const m of s.matchAll(/(["'`])((?:\\.|(?!\1).)*?)\1/g)) {
    let raw = m[2];
    try {
      raw = JSON.parse(`"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\\'/g, "'")}"`);
    } catch {
      /* keep raw */
    }
    if (TR.test(raw) && raw.length < 200) set.add(raw);
  }
}

const arr = [...set].sort((a, b) => b.length - a.length);
console.log("unique", arr.length);
for (const x of arr) console.log(JSON.stringify(x));
