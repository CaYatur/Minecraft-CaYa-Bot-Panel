/**
 * Electron's Windows import library exports ArrayBuffer::GetBackingStore with
 * libc++ std::__Cr::shared_ptr. MSVC looks up std::shared_ptr and the link fails.
 * ArrayBuffer::Data() is the same pointer and has a stable export.
 * Idempotent. Run before electron-rebuild of native modules that use nan.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "node_modules", "nan", "nan_typedarray_contents.h");
const source = fs.readFileSync(file, "utf8");
const from = "data = static_cast<char*>(buffer->GetBackingStore()->Data()) + byte_offset;";
const to = "data = static_cast<char*>(buffer->Data()) + byte_offset;";
if (source.includes(to) && !source.includes(from)) {
  console.log("nan already uses ArrayBuffer::Data()");
  process.exit(0);
}
if (!source.includes(from)) {
  console.error("nan typed-array header does not contain the expected GetBackingStore line");
  process.exit(1);
}
fs.writeFileSync(file, source.replace(from, to));
console.log("patched", path.relative(root, file));
