/**
 * bNamesX PC miner: double-click entry point (built into bnamesx-miner.exe by scripts/build-pc-miner.ts).
 *   1. app dir %APPDATA%\bnamesx-miner; first run makes the hot key there (never uploaded)
 *   2. local page on http://127.0.0.1:<port>/?t=<token>, opened in the default browser
 *   3. mines this PC's slice (all-digit names, 1–4 chars) to the vault, capped at 1 BSV in total
 * Flags: --dry-run (simulated chain, nothing signed or broadcast), --no-open, --port N.
 */
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { appDir, ensureHotKey, useAppDir, writeList } from './app.js';
import { Controller } from './controller.js';
import { startServer } from './server.js';
import { ACCOUNT, CAP_SATS, RANGE_LABEL } from './defaults.js';
// Embedded at build time (bun): the page and the bWalletX connect bundle.
import html from './ui.html' with { type: 'text' };
import connectJs from './vendor/bwalletx-connect.global.js' with { type: 'text' };

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const noOpen = args.includes('--no-open');
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 47402;

/** Half-block QR for the console (white quiet zone; works in Windows Terminal and conhost). */
const terminalQr = (text: string) => {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && modules.get(y, x) === 1;
  const lines: string[] = [];
  for (let y = -2; y < n + 2; y += 2) {
    let l = '';
    for (let x = -2; x < n + 2; x++) {
      const top = dark(x, y), bot = dark(x, y + 1);
      l += top && bot ? ' ' : top ? '▄' : bot ? '▀' : '█';
    }
    lines.push('  ' + l);
  }
  return lines.join('\n');
};

const say = (m: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${m}`);

const openBrowser = (url: string) => {
  if (noOpen) return;
  const [cmd, a] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, a, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
};

async function main() {
  // The worker is the build's second entry point: dist layout pcminer/main.js + opns/minerWorker.js.
  if (process.versions.bun) (await import('../opns/miner.js')).setWorkerUrl(new URL('../opns/minerWorker.js', import.meta.url));
  if (args.includes('--bench')) {
    const { benchmark } = await import('../opns/miner.js');
    const r = await benchmark(5);
    console.log(`proof of work: ${(r.rate / 1e6).toFixed(1)} MH/s on ${r.threads} threads (about ${(2 ** 22 / r.rate).toFixed(1)} s per character)`);
    return;
  }
  if (dry && !process.env.BNAMESX_MINER_HOME) process.env.BNAMESX_MINER_HOME = `${appDir()}-dry-run`;
  const dir = useAppDir();
  writeList();
  console.log('bNamesX PC miner');
  console.log(`  data folder: ${dir}`);
  console.log(`  this PC mines: ${RANGE_LABEL}`);
  console.log(`  spending cap: ${CAP_SATS.toLocaleString('en-US')} sats (1 BSV) in total`);
  if (dry) console.log('  DRY RUN: simulated chain, nothing is signed or broadcast');

  let payAddress = 'dry-run-no-key';
  if (!dry) {
    const k = await ensureHotKey();
    payAddress = k.payAddress;
    say(k.created ? `Made this PC's hot key (account ${ACCOUNT}), kept only in the data folder.` : `Hot key ${ACCOUNT} loaded.`);
    say(`Fund address: ${payAddress}`);
  }

  const { utxos } = await import('../wallet.js');
  const { bsvUsd } = await import('../market.js');
  let bal = { at: 0, sats: 0 };
  const payBalance = async () => {
    if (dry) return 0;
    if (Date.now() - bal.at > 30_000) bal = { at: Date.now(), sats: (await utxos(payAddress)).reduce((n, u) => n + u.value, 0) };
    return bal.sats;
  };

  const ctl = new Controller(dry);
  let quitting = false;
  const quit = async () => {
    if (quitting) process.exit(130);
    quitting = true;
    say('Stopping after the current step (everything is saved; start the miner again to resume)…');
    await ctl.pause();
    const t = setInterval(() => {
      if (ctl.phase !== 'running' && ctl.phase !== 'pausing') {
        clearInterval(t);
        say('Stopped.');
        process.exit(0);
      }
    }, 500);
  };
  process.on('SIGINT', () => void quit());
  process.on('SIGTERM', () => void quit());

  const srv = await startServer({ ctl, payAddress, html, connectJs, payBalance, usdPerBsv: bsvUsd, onStop: () => void quit() }, port);
  say(`Miner page: ${srv.url}`);
  say('Leave this window open. Ctrl+C (or Stop on the page) stops safely.');
  openBrowser(srv.url);

  if (!dry) {
    console.log(terminalQr(`bitcoin:${payAddress}`));
  }

  // Auto start: when coins are waiting at the fund address, or to resume a job that already spent.
  const { loadState } = await import('../opns/headless.js');
  let userPaused = false;
  const origPause = ctl.pause.bind(ctl);
  ctl.pause = async () => ((userPaused = true), origPause());
  const origStart = ctl.start.bind(ctl);
  ctl.start = async () => ((userPaused = false), origStart());
  const tick = async () => {
    if (dry || quitting || userPaused) return;
    if (!['idle', 'funds', 'error'].includes(ctl.phase)) return;
    const resumable = ctl.phase === 'idle' && (loadState(ACCOUNT)?.spentSats ?? 0) > 0;
    const waiting = await payBalance().catch(() => 0);
    if (waiting >= 5_000 || resumable) {
      say(waiting ? `Funds arrived (${waiting} sats): mining.` : 'Resuming the saved job.');
      await origStart();
    }
  };
  setInterval(() => void tick(), 30_000);
  void tick();

  setInterval(async () => {
    const s = await ctl.status();
    const m = s.summary;
    say(`${s.phase}${s.current ? ` "${s.current}"` : ''} · mined ${m?.done ?? 0}/${m?.total ?? 0} · spent ${m?.spentSats ?? 0}/${CAP_SATS} sats${s.error ? ` · ${s.error}` : ''}`);
  }, 60_000);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  console.error('Press Enter to close.');
  process.stdin.once('data', () => process.exit(1));
});
