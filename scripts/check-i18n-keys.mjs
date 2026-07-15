import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDict(path) {
  const src = readFileSync(path, "utf8");
  const m = src.match(/export const \w+[^=]*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error(`No object export in ${path}`);
  let objSrc = m[1].replace(/,(\s*[}\]])/g, "$1");
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${objSrc});`)();
}

function flat(o, p = "") {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const np = p ? `${p}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flat(v, np));
    else out.push([np, String(v)]);
  }
  return out;
}

const root = resolve(import.meta.dirname, "..");
const en = Object.fromEntries(flat(loadDict(resolve(root, "web/src/i18n/dict/en.ts"))));
const tr = Object.fromEntries(flat(loadDict(resolve(root, "web/src/i18n/dict/tr.ts"))));
const enKeys = Object.keys(en).sort();
const trKeys = Object.keys(tr).sort();
const onlyEn = enKeys.filter((k) => !(k in tr));
const onlyTr = trKeys.filter((k) => !(k in en));
const same =
  enKeys.filter((k) => k in tr && en[k] === tr[k] && /[çğıöşüÇĞİÖŞÜ]/.test(en[k]));

console.log(`EN=${enKeys.length} TR=${trKeys.length}`);
console.log(`\nOnly EN (${onlyEn.length}):`);
for (const k of onlyEn) console.log(" +", k, "=", JSON.stringify(en[k]).slice(0, 80));
console.log(`\nOnly TR (${onlyTr.length}):`);
for (const k of onlyTr) console.log(" -", k, "=", JSON.stringify(tr[k]).slice(0, 80));
console.log(`\nIdentical EN=TR with Turkish chars (${same.length}) — may need EN text:`);
for (const k of same.slice(0, 40)) console.log(" =", k);
