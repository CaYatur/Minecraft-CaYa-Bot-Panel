import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../config/paths";
import { createLogger } from "../utils/logger";

const log = createLogger("store");

// per-file write queues so concurrent saves can't interleave
const writeChains = new Map<string, Promise<void>>();

export function loadJson<T>(fileName: string, fallback: T): T {
  const file = path.join(DATA_DIR, fileName);
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    log.error(`${fileName} okunamadı, varsayılan kullanılıyor`, String(err));
    return fallback;
  }
}

/** atomic save: write temp file then rename over the target */
export function saveJson(fileName: string, data: unknown): Promise<void> {
  const file = path.join(DATA_DIR, fileName);
  const prev = writeChains.get(fileName) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const tmp = file + ".tmp";
      await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await fs.promises.rename(tmp, file);
    })
    .catch((err) => {
      log.error(`${fileName} yazılamadı`, String(err));
    });
  writeChains.set(fileName, next);
  return next;
}
