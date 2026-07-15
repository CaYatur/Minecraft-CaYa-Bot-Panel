import * as path from "path";
import { SCHEMATICS_FILES_DIR } from "../../config/paths";

/** Path traversal engeli: sadece schematics/files altında dosya */
export function resolveSchematicFile(filename: string): string {
  const base = path.resolve(SCHEMATICS_FILES_DIR);
  const cleaned = path.basename(String(filename || "").replace(/\\/g, "/"));
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("Geçersiz şema dosya adı");
  }
  const full = path.resolve(base, cleaned);
  if (!full.startsWith(base + path.sep) && full !== base) {
    throw new Error("Şema yolu güvenlik engeline takıldı");
  }
  return full;
}

export function assertSchematicId(id: string): string {
  const s = String(id || "").trim();
  if (!s || s.length > 80) throw new Error("Geçersiz şema id");
  // uuid or sample-platform style
  if (!/^[A-Za-z0-9_\-]+$/.test(s)) throw new Error("Şema id geçersiz karakter içeriyor");
  return s;
}
