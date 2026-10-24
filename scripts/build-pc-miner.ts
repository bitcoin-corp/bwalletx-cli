/**
 * Build the bNamesX PC miner as one standalone executable (no Node needed on the PC).
 *   bun scripts/build-pc-miner.ts                 → dist-pc/bnamesx-miner.exe (Windows x64)
 *   bun scripts/build-pc-miner.ts bun-darwin-arm64 → dist-pc/bnamesx-miner-darwin-arm64 (local testing)
 * better-sqlite3 (a V8 addon) is swapped for src/pcminer/sqliteShim.cjs (bun:sqlite); knex's other drivers are
 * never loaded and stay external. The OpNS proof-of-work worker is a second entry point inside the binary.
 */
import { resolve } from 'node:path';

const target = (process.argv[2] ?? 'bun-windows-x64') as 'bun-windows-x64';
const root = resolve(import.meta.dir, '..');
const outfile = resolve(root, 'dist-pc', target === 'bun-windows-x64' ? 'bnamesx-miner.exe' : `bnamesx-miner-${target.replace(/^bun-/, '')}`);

const shim = {
  name: 'better-sqlite3-on-bun',
  setup(b: {
    onResolve: (o: { filter: RegExp }, cb: () => { path: string }) => void;
    onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: 'ts' }>) => void;
  }) {
    b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: resolve(root, 'src/pcminer/sqliteShim.cjs') }));
    // `createRequire(import.meta.url)` hides the CommonJS toolbox from the bundler: use the bundler's own require.
    b.onLoad({ filter: /src\/(brc100|opns\/headless)\.ts$/ }, async ({ path }) => ({
      contents: (await Bun.file(path).text()).replace(/^const require = createRequire\(import\.meta\.url\);$/m, ''),
      loader: 'ts',
    }));
  },
};

const r = await Bun.build({
  entrypoints: [resolve(root, 'src/pcminer/main.ts'), resolve(root, 'src/opns/minerWorker.ts')],
  compile: { target, outfile, windows: { title: 'bNamesX Miner', hideConsole: false } } as never,
  minify: true,
  sourcemap: 'none',
  plugins: [shim as never],
  external: ['mariadb', 'mariadb/callback', 'pg', 'pg-native', 'pg-query-stream', 'mysql', 'mysql2', 'sqlite3', 'tedious', 'oracledb', 'cpu-features', 'ssh2'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
if (!r.success) {
  for (const l of r.logs) console.error(l);
  process.exit(1);
}
console.log(`built ${outfile}`);
