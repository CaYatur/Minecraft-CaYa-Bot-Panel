import type { ReactNode } from "react";

/**
 * prismarine-chat toAnsi() çıktısındaki SGR kodlarını renkli <span>'lere çevirir.
 * MC'nin 16 klasik rengi + bold/italic/underline desteklenir; bilinmeyen kodlar yutulur.
 */
const FG: Record<number, string> = {
  30: "#000000",
  31: "#AA0000",
  32: "#00AA00",
  33: "#FFAA00",
  34: "#5555FF",
  35: "#AA00AA",
  36: "#00AAAA",
  37: "#AAAAAA",
  90: "#555555",
  91: "#FF5555",
  92: "#55FF55",
  93: "#FFFF55",
  94: "#7f7fff",
  95: "#FF55FF",
  96: "#55FFFF",
  97: "#FFFFFF"
};

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[([0-9;]*)m/g;

export function ansiToSpans(input: string): ReactNode[] {
  const out: ReactNode[] = [];
  let style: { color?: string; fontWeight?: string; fontStyle?: string; textDecoration?: string } = {};
  let last = 0;
  let key = 0;

  const pushText = (text: string) => {
    if (!text) return;
    out.push(
      <span key={key++} style={{ ...style }}>
        {text}
      </span>
    );
  };

  for (const m of input.matchAll(ANSI_RE)) {
    pushText(input.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const codes = (m[1] ?? "").split(";").filter(Boolean).map(Number);
    if (codes.length === 0) codes.push(0);
    let i = 0;
    while (i < codes.length) {
      const c = codes[i]!;
      if (c === 0) style = {};
      else if (c === 1) style.fontWeight = "bold";
      else if (c === 3) style.fontStyle = "italic";
      else if (c === 4) style.textDecoration = "underline";
      else if (c === 38 && codes[i + 1] === 2) {
        // truecolor: 38;2;r;g;b (1.16+ hex renkleri)
        const [r, g, b] = [codes[i + 2] ?? 255, codes[i + 3] ?? 255, codes[i + 4] ?? 255];
        style.color = `rgb(${r},${g},${b})`;
        i += 4;
      } else if (FG[c]) style.color = FG[c];
      i++;
    }
  }
  pushText(input.slice(last));
  return out;
}
