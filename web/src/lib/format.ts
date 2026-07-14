export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("tr-TR", { hour12: false });
}

export function fmtPos(p: { x: number; y: number; z: number }): string {
  return `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
}

/** oyuncu adından deterministik pastel renk */
export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 70%)`;
}

export const DIMENSION_TR: Record<string, string> = {
  overworld: "Yeryüzü",
  the_nether: "Nether",
  the_end: "End"
};

export function dimensionLabel(d: string): string {
  return DIMENSION_TR[d] ?? d;
}
