/**
 * Sunucunun gönderdiği declare_commands ağacını, çalıştırılabilir komut
 * satırlarına indirger. Argümanlar aynı satırda `<ad>` olarak durur; her
 * redirect en fazla bir kez takip edilir. Derinlik ve satır sayısı sınırlıdır.
 */

export const COMMAND_TREE_LIMITS = { maxDepth: 8, maxLines: 400 };

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
 */
export function flattenCommandNodes(
  nodes: CommandNode[],
  root = 0,
  limits?: Partial<typeof COMMAND_TREE_LIMITS>
): CommandTreeFlat {
  const maxDepth = limits?.maxDepth ?? COMMAND_TREE_LIMITS.maxDepth;
  const maxLines = limits?.maxLines ?? COMMAND_TREE_LIMITS.maxLines;
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

  const queue: Frame[] = [{ index: root, parts: [], redirectsLeft: 1, seen: new Set(), skipToken: false }];
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

  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
