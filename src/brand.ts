/**
 * bWalletX branding for the terminal: the block-letter banner (yellow, with a gold shimmer sweep on a TTY) and the
 * yellow pairing QR. Plain yellow without animation when output is piped, in CI, or when NO_COLOR is set.
 */
const ART = [
  '██████╗ ██╗    ██╗ █████╗ ██╗     ██╗     ███████╗████████╗██╗  ██╗',
  '██╔══██╗██║    ██║██╔══██╗██║     ██║     ██╔════╝╚══██╔══╝╚██╗██╔╝',
  '██████╔╝██║ █╗ ██║███████║██║     ██║     █████╗     ██║    ╚███╔╝ ',
  '██╔══██╗██║███╗██║██╔══██║██║     ██║     ██╔══╝     ██║    ██╔██╗ ',
  '██████╔╝╚███╔███╔╝██║  ██║███████╗███████╗███████╗   ██║   ██╔╝ ██╗',
  '╚═════╝  ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝',
];

const tty = () => !!process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;
const truecolor = () => /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
const rgb = (r: number, g: number, b: number) => (truecolor() ? `\x1b[38;2;${r};${g};${b}m` : '\x1b[33m');
const RESET = '\x1b[0m';
const GOLD = [245, 184, 0] as const; // #F5B800
const LIGHT = [255, 236, 150] as const;

export const yellow = (s: string) => (tty() || process.env.FORCE_COLOR ? `${rgb(...GOLD)}${s}${RESET}` : s);

/** One frame: gold, with a bright band centred on column `at`. */
const frame = (at: number) =>
  ART.map((line) =>
    [...line]
      .map((ch, x) => {
        const d = Math.abs(x - at);
        const t = d < 6 ? 1 - d / 6 : 0;
        const c = GOLD.map((g, i) => Math.round(g + (LIGHT[i] - g) * t)) as [number, number, number];
        return `${rgb(...c)}${ch}`;
      })
      .join('') + RESET,
  ).join('\n');

/** Prints the banner; on a terminal a light band sweeps across it once (~0.7 s). */
export async function banner(out: (s: string) => void = (s) => process.stdout.write(s)) {
  const width = Math.max(...ART.map((l) => l.length));
  // The animation moves the cursor back up ART.length lines; in a window narrower than the art the lines wrap, the
  // count is wrong and the frames smear over everything after (the pairing QR included). Animate only when it fits.
  const cols = process.stdout.columns;
  if (!tty() || !cols || cols <= width) {
    // No animation: the still logo (yellow on a terminal), or the name alone in a window too narrow for the art.
    out(cols && cols <= width ? yellow('bWalletX') + '\n' : ART.map((l) => (tty() ? yellow(l) : l)).join('\n') + '\n');
    return;
  }
  out('\x1b[?25l'); // hide cursor
  for (let at = -6; at <= width + 6; at += 3) {
    out(frame(at) + '\n');
    await new Promise((r) => setTimeout(r, 25));
    out(`\x1b[${ART.length}A`); // back to the top of the banner
  }
  out(ART.map((l) => yellow(l)).join('\n') + '\n\x1b[?25h');
}

/**
 * The pairing QR for a terminal, drawn from the modules themselves (owner, 13 Nov 2026: it must scan in the CLI).
 * Background colours fill a terminal cell's whole height, including the extra line spacing VS Code and others add;
 * half-block glyphs (▀▄) don't, which leaves dark stripes between rows that phones can't read. So when the window is
 * tall and wide enough, each module is two background-coloured spaces on its own row. Otherwise it falls back to
 * half-blocks (half the height) with a hint. Pure black on pure white, whatever the theme.
 */
export const terminalQr = (modules: { size: number; get(r: number, c: number): number | boolean }, quiet = 2) => {
  const n = modules.size + quiet * 2;
  const dark = (r: number, c: number) =>
    r >= quiet && c >= quiet && r < n - quiet && c < n - quiet && !!modules.get(r - quiet, c - quiet);
  const BLK = '\x1b[48;2;0;0;0m';
  const WHT = '\x1b[48;2;255;255;255m';
  const RST = '\x1b[0m';
  const rows = process.stdout.rows ?? 0;
  const cols = process.stdout.columns ?? 0;
  const title = ' bWalletX · scan to pair ';
  if (rows >= n + 4 && cols >= n * 2) {
    const lines: string[] = [];
    for (let r = 0; r < n; r++) {
      let l = '';
      for (let c = 0; c < n; c++) l += (dark(r, c) ? BLK : WHT) + '  ';
      lines.push(l + RST);
    }
    return [yellow(' '.repeat(Math.max(0, n - Math.floor(title.length / 2))) + title), ...lines].join('\n') + '\n';
  }
  // Half height: the top module is the glyph colour, the bottom one the cell background.
  const FG = (d: boolean) => (d ? '\x1b[38;2;0;0;0m' : '\x1b[38;2;255;255;255m');
  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let l = '';
    for (let c = 0; c < n; c++) l += FG(dark(r, c)) + (r + 1 < n && dark(r + 1, c) ? BLK : WHT) + '▀';
    lines.push(l + RST);
  }
  const need = n + 4;
  return (
    [yellow(' '.repeat(Math.max(0, Math.floor((n - title.length) / 2))) + title), ...lines].join('\n') +
    '\n' +
    yellow(`If your phone can't read this, make this window at least ${need} rows tall and ${n * 2} wide and run again (or add --open-qr).`) +
    '\n'
  );
};

/** Colour a terminal QR (from qrcode's `small` renderer) yellow on the terminal background, framed with the brand. */
export const brandQr = (qr: string) => {
  const lines = qr.replace(/\n+$/, '').split('\n');
  // Visible width: escape codes don't take a column.
  const w = Math.max(...lines.map((l) => [...l.replace(/\x1b\[[0-9;]*m/g, '')].length));
  const title = ' bWalletX · scan to pair ';
  const pad = Math.max(0, Math.floor((w - title.length) / 2));
  return [yellow(' '.repeat(pad) + title), ...lines.map((l) => yellow(l))].join('\n') + '\n';
};
