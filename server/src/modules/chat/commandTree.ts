/**
 * Sunucunun gönderdiği declare_commands ağacını, çalıştırılabilir komut
 * satırlarına indirger. Argümanlar aynı satırda `<ad>` olarak durur; her
 * redirect en fazla bir kez takip edilir. Derinlik ve satır sayısı sınırlıdır.
 */

export const COMMAND_TREE_LIMITS = { maxDepth: 8, maxLines: 2000 };

export interface CommandNode {
  kind: "root" | "literal" | "argument";
  name?: string;
  executable?: boolean;
  children?: number[];
  redirect?: number;
}

export interface CommandTreeFlat {
  lines: string[];
  truncated: boolean;
}

interface Frame {
  index: number;
  parts: string[];
  redirectsLeft: number;
  seen: Set<number>;
  /** Redirect hedefi yeniden tüketilmez; yalnız çocukları açılır. */
  skipToken: boolean;
}

function tokenOf(node: CommandNode): string | null {
  if ((node.kind === "literal" || node.kind === "argument") && node.name) {
    return node.kind === "argument" ? `<${node.name}>` : node.name;
  }
  return null;
}

function childIndexes(node: CommandNode, count: number, seen: Set<number>): number[] {
  const out: number[] = [];
  for (const raw of node.children ?? []) {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) continue;
    out.push(index);
  }
  return out;
}

/**
 * Çalıştırılabilir yolları düzleştirir. `root` genelde 0'dır.
 * Sınır aşılırsa `truncated` true olur ve eldeki satırlar döner.
 *
 * Satır bütçesi kök komutlara sırayla dağıtılır: op yetkili bir Paper botunda ağaç
 * 17 binden fazla satıra açılıyor ve tek bir BFS sınırı 209 kök komutun 81'ini
 * listeden tamamen düşürüyordu. Artık her kök en az bir satırla görünür.
 * `minecraft:give` gibi ad alanlı kopyalar, düz `give` varsa gizlenir.
 */
export function flattenCommandNodes(
  nodes: CommandNode[],
  root = 0,
  limits?: Partial<typeof COMMAND_TREE_LIMITS>
): CommandTreeFlat {
  const maxDepth = limits?.maxDepth ?? COMMAND_TREE_LIMITS.maxDepth;
  const maxLines = limits?.maxLines ?? COMMAND_TREE_LIMITS.maxLines;
  const start = nodes[root];
  if (!start || start.kind !== "root") return walkFrom(nodes, root, maxDepth, maxLines);

  // top-level commands, with namespaced duplicates of a plain command dropped
  const tops = childIndexes(start, nodes.length, new Set([root]));
  const plain = new Set(tops.map((i) => nodes[i]?.name).filter((n): n is string => Boolean(n) && !n!.includes(":")));
  const kept = tops.filter((i) => {
    const name = nodes[i]?.name ?? "";
    const colon = name.indexOf(":");
    return colon < 0 || !plain.has(name.slice(colon + 1));
  });

  const perTop = kept.map((i) => walkFrom(nodes, i, maxDepth, maxLines, new Set([root])));
  let truncated = perTop.some((t) => t.truncated);
  const lines: string[] = [];
  const known = new Set<string>();
  // round-robin: shortest lines of every command first, then deeper ones
  for (let round = 0; lines.length < maxLines; round++) {
    let added = false;
    for (const t of perTop) {
      const line = t.lines[round];
      if (line === undefined) continue;
      added = true;
      if (known.has(line)) continue;
      if (lines.length >= maxLines) break;
      known.add(line);
      lines.push(line);
    }
    if (!added) break;
  }
  if (perTop.some((t) => t.lines.some((line) => !known.has(line)))) truncated = true;
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { lines, truncated };
}

/** BFS from one node; lines come back in visit order (short paths first). */
function walkFrom(
  nodes: CommandNode[],
  root: number,
  maxDepth: number,
  maxLines: number,
  initialSeen: Set<number> = new Set()
): CommandTreeFlat {
  const lines: string[] = [];
  const known = new Set<string>();
  let truncated = false;
  let visits = 0;
  const maxVisits = Math.max(2000, maxLines * 40);

  const emit = (parts: string[]) => {
    if (parts.length === 0 || parts.length > maxDepth) {
      if (parts.length > maxDepth) truncated = true;
      return;
    }
    const line = parts.join(" ");
    if (known.has(line)) return;
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    known.add(line);
    lines.push(line);
  };

  const queue: Frame[] = [{ index: root, parts: [], redirectsLeft: 1, seen: new Set(initialSeen), skipToken: false }];
  let cursor = 0;

  while (cursor < queue.length) {
    if (visits++ > maxVisits || queue.length - cursor > maxLines * 30) {
      truncated = true;
      break;
    }
    const frame = queue[cursor++]!;
    if (frame.seen.has(frame.index)) continue;
    const node = nodes[frame.index];
    if (!node) continue;

    const seen = new Set(frame.seen);
    seen.add(frame.index);
    let parts = frame.parts;
    let current = node;
    let skipEmit = frame.skipToken;

    if (!frame.skipToken) {
      const token = tokenOf(current);
      if (token) {
        if (parts.length + 1 > maxDepth) {
          truncated = true;
          continue;
        }
        parts = parts.concat(token);
      }
    }

    while (true) {
      if (!skipEmit && current.executable) emit(parts);
      skipEmit = false;

      const children = childIndexes(current, nodes.length, seen);
      const argKids = children.filter((index) => nodes[index]?.kind === "argument");
      const otherKids = children.filter((index) => nodes[index]?.kind !== "argument");
      const canFold = argKids.length === 1 && otherKids.length === 0 && current.redirect == null;
      if (canFold) {
        const next = nodes[argKids[0]!]!;
        if (!next.name || parts.length + 1 > maxDepth) {
          if (parts.length + 1 > maxDepth) truncated = true;
          break;
        }
        seen.add(argKids[0]!);
        parts = parts.concat(`<${next.name}>`);
        current = next;
        continue;
      }

      if (parts.length >= maxDepth && (children.length > 0 || current.redirect != null)) {
        truncated = true;
        break;
      }

      for (const child of children) {
        queue.push({ index: child, parts, redirectsLeft: frame.redirectsLeft, seen, skipToken: false });
      }
      const redirect = current.redirect;
      if (redirect != null && frame.redirectsLeft > 0 && redirect >= 0 && redirect < nodes.length) {
        queue.push({
          index: redirect,
          parts,
          redirectsLeft: frame.redirectsLeft - 1,
          seen: new Set(),
          skipToken: true
        });
      }
      break;
    }
  }

  return { lines, truncated };
}

function flagKind(flags: unknown, extra: { name?: string; parser?: string }): { kind: CommandNode["kind"]; executable: boolean } {
  if (flags && typeof flags === "object") {
    const row = flags as Record<string, unknown>;
    const type = Number(row.command_node_type ?? 0);
    const kind: CommandNode["kind"] = type === 1 ? "literal" : type === 2 ? "argument" : "root";
    const mark = row.has_command;
    return { kind, executable: mark === true || mark === 1 || mark === "1" };
  }
  if (typeof flags === "number" && Number.isFinite(flags)) {
    const type = flags & 3;
    const kind: CommandNode["kind"] = type === 1 ? "literal" : type === 2 ? "argument" : "root";
    return { kind, executable: (flags & 4) !== 0 };
  }
  if (extra.parser) return { kind: "argument", executable: false };
  if (extra.name) return { kind: "literal", executable: false };
  return { kind: "root", executable: false };
}

/** minecraft-protocol'ün ayrıştırdığı declare_commands paketi. Bozuk pakette null. */
export function flattenDeclarePacket(packet: unknown, limits?: Partial<typeof COMMAND_TREE_LIMITS>): CommandTreeFlat | null {
  if (!packet || typeof packet !== "object") return null;
  const rawNodes = (packet as { nodes?: unknown }).nodes;
  if (!Array.isArray(rawNodes)) return null;
  const rootRaw = Number((packet as { rootIndex?: unknown }).rootIndex ?? 0);
  const root = Number.isInteger(rootRaw) && rootRaw >= 0 && rootRaw < rawNodes.length ? rootRaw : 0;

  const nodes: CommandNode[] = rawNodes.map((raw) => {
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const extraRaw = row.extraNodeData;
    const extra = extraRaw && typeof extraRaw === "object" ? (extraRaw as Record<string, unknown>) : {};
    const name = typeof extra.name === "string" ? extra.name : undefined;
    const parser = typeof extra.parser === "string" ? extra.parser : undefined;
    const flags = flagKind(row.flags, { name, parser });
    const children = Array.isArray(row.children) ? row.children.map((value) => Number(value)).filter((value) => Number.isInteger(value)) : [];
    const redirectRaw = row.redirectNode ?? row.redirect;
    const redirect = typeof redirectRaw === "number" && Number.isInteger(redirectRaw) ? redirectRaw : undefined;
    const leaf = children.length === 0 && redirect == null && flags.kind !== "root";
    return {
      kind: flags.kind,
      name,
      executable: flags.executable || leaf,
      children,
      redirect
    };
  });

  return flattenCommandNodes(nodes, root, limits);
}
