import { loadJson, saveJson } from "../../persistence/store";
import type { Waypoint } from "../../types";
import { newId } from "../../types";

const FILE = "world-memory.json";

export interface ChestMemory {
  id: string;
  serverId: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  items: { name: string; count: number }[];
  updatedAt: number;
}

export interface OreMemory {
  serverId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  seenAt: number;
}

interface WorldMemoryFile {
  chests: ChestMemory[];
  ores: OreMemory[];
}

/**
 * Ortak world hafızası (Faz 10) — sunucu bazlı chest/cevher notları.
 */
export class WorldMemory {
  private data: WorldMemoryFile = { chests: [], ores: [] };

  load() {
    this.data = loadJson<WorldMemoryFile>(FILE, { chests: [], ores: [] });
  }

  private persist() {
    void saveJson(FILE, this.data);
  }

  chestsFor(serverId: string): ChestMemory[] {
    return this.data.chests.filter((c) => c.serverId === serverId);
  }

  upsertChest(input: Omit<ChestMemory, "id" | "updatedAt"> & { id?: string }): ChestMemory {
    const existing = this.data.chests.find(
      (c) =>
        c.serverId === input.serverId &&
        Math.floor(c.x) === Math.floor(input.x) &&
        Math.floor(c.y) === Math.floor(input.y) &&
        Math.floor(c.z) === Math.floor(input.z)
    );
    if (existing) {
      existing.items = input.items;
      existing.updatedAt = Date.now();
      existing.dimension = input.dimension;
      this.persist();
      return existing;
    }
    const row: ChestMemory = {
      id: input.id ?? newId(),
      serverId: input.serverId,
      x: input.x,
      y: input.y,
      z: input.z,
      dimension: input.dimension,
      items: input.items,
      updatedAt: Date.now()
    };
    this.data.chests.push(row);
    this.persist();
    return row;
  }

  findItem(serverId: string, itemName: string): ChestMemory | undefined {
    return this.chestsFor(serverId).find((c) => c.items.some((i) => i.name.includes(itemName)));
  }

  noteOre(serverId: string, name: string, x: number, y: number, z: number, dimension: string) {
    this.data.ores = this.data.ores.filter(
      (o) => !(o.serverId === serverId && Math.floor(o.x) === Math.floor(x) && Math.floor(o.y) === Math.floor(y) && Math.floor(o.z) === Math.floor(z))
    );
    this.data.ores.push({ serverId, name, x, y, z, dimension, seenAt: Date.now() });
    if (this.data.ores.length > 500) this.data.ores.splice(0, this.data.ores.length - 500);
    this.persist();
  }

  oresFor(serverId: string): OreMemory[] {
    return this.data.ores.filter((o) => o.serverId === serverId);
  }
}

export type { Waypoint };
