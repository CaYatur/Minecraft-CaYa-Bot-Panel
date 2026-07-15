import { loadJson, saveJson } from "../persistence/store";
import type { Waypoint } from "../types";
import { newId } from "../types";
import { PanelError } from "./BotManager";

const FILE = "waypoints.json";

/** Sunucu profili bazlı isimli konumlar (ortak dünya hafızasının ilk parçası). */
export class WaypointStore {
  private byServer: Record<string, Waypoint[]> = {};

  load() {
    this.byServer = loadJson<Record<string, Waypoint[]>>(FILE, {});
  }

  forServer(serverId: string): Waypoint[] {
    return this.byServer[serverId] ?? [];
  }

  create(serverId: string, input: { name: string; x: number; y: number; z: number; dimension?: string; note?: string }): Waypoint {
    const name = String(input.name || "").trim();
    if (!name) throw new PanelError("Waypoint adı boş olamaz.");
    const list = this.byServer[serverId] ?? (this.byServer[serverId] = []);
    if (list.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
      throw new PanelError(`"${name}" adlı waypoint bu sunucuda zaten var.`, 409);
    }
    const wp: Waypoint = {
      id: newId(),
      serverId,
      name,
      x: Math.round(Number(input.x) * 100) / 100,
      y: Math.round(Number(input.y) * 100) / 100,
      z: Math.round(Number(input.z) * 100) / 100,
      dimension: input.dimension ?? "overworld",
      note: input.note
    };
    if (![wp.x, wp.y, wp.z].every(Number.isFinite)) throw new PanelError("Geçersiz koordinat.");
    list.push(wp);
    void saveJson(FILE, this.byServer);
    return wp;
  }

  delete(id: string) {
    for (const [sid, list] of Object.entries(this.byServer)) {
      const idx = list.findIndex((w) => w.id === id);
      if (idx >= 0) {
        list.splice(idx, 1);
        if (list.length === 0) delete this.byServer[sid];
        void saveJson(FILE, this.byServer);
        return;
      }
    }
    throw new PanelError("Waypoint bulunamadı.", 404);
  }

  get(id: string): Waypoint {
    for (const list of Object.values(this.byServer)) {
      const wp = list.find((w) => w.id === id);
      if (wp) return wp;
    }
    throw new PanelError("Waypoint bulunamadı.", 404);
  }
}
