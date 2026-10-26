#!/usr/bin/env node
/**
 * Check the BRC-217 test mint at <txid>_0 against the live indexers (read-only, no wallet):
 *   - api.1sat.app (1sat-stack): /1sat/txo/<outpoint>, /1sat/ordfs/metadata/<outpoint>, /content/<outpoint>
 *   - ordinals.gorillapool.io:   /api/txos/<outpoint>, /content/<outpoint>
 *   - ORDFS:                     https://ordfs.network/<outpoint>  (serves the PNG?)
 *   - our verifier:              PR #194 verifyBrc217 + verifyIssueTx's identity binding, on the raw tx
 *
 *   node scripts/brc217-check.mjs <txid>[_vout] [--wait <minutes>]   (vout defaults to 0)   (polls every 30 s until all pass or time runs out)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@bsv/sdk';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { verifyMintScript } = await import(join(root, 'dist', 'brc217Mint.js'));

const [txid, voutArg] = (process.argv[2] ?? '').split(/[_.]/);
const vout = Number(voutArg ?? 0);
if (!/^[0-9a-f]{64}$/i.test(txid ?? '') || !Number.isInteger(vout)) {
  console.error('usage: node scripts/brc217-check.mjs <txid> [--wait <minutes>]');
  process.exit(2);
}
const wi = process.argv.indexOf('--wait');
const waitMin = wi > 0 ? Number(process.argv[wi + 1]) : 10;
const op = `${txid}_${vout}`;
const opDot = `${txid}.${vout}`;
const WANT = 'image/png';

const get = async (url, as = 'json') => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const ct = r.headers.get('content-type') ?? '';
    if (!r.ok) return { ok: false, status: r.status, ct };
    if (as === 'bytes') return { ok: true, status: r.status, ct, bytes: new Uint8Array(await r.arrayBuffer()) };
    const text = await r.text();
    try {
      return { ok: true, status: r.status, ct, json: JSON.parse(text) };
    } catch {
      return { ok: true, status: r.status, ct, text };
    }
  } catch (e) {
    return { ok: false, status: 0, ct: '', error: e instanceof Error ? e.message : String(e) };
  }
};

/** Every content-type-looking string anywhere in an indexer's JSON. */
const typesIn = (j, out = new Set()) => {
  if (j && typeof j === 'object')
    for (const [k, v] of Object.entries(j)) {
      if (typeof v === 'string' && /^(type|contentType|content_type)$/i.test(k) && v.includes('/')) out.add(v);
      else typesIn(v, out);
    }
  return out;
};
const isPng = (b) => b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const hasInscription = (j) => JSON.stringify(j ?? '').match(/"(insc|inscription|origin)"|ins:/) !== null;

async function indexerRow(label, urls) {
  const seen = [];
  for (const url of urls) {
    const r = await get(url);
    if (!r.ok) continue;
    const types = [...typesIn(r.json)];
    const detail = `${url} -> inscription: ${hasInscription(r.json)}, types: ${types.join(', ') || 'none'}`;
    if (types.includes(WANT)) return { label, pass: true, detail };
    seen.push(detail);
  }
  return { label, pass: false, detail: seen.join(' ; ') || `not indexed yet (${urls.join(' | ')})` };
}

async function contentRow(label, url) {
  const r = await get(url, 'bytes');
  if (!r.ok) return { label, pass: false, detail: `${url} -> HTTP ${r.status}${r.error ? ` ${r.error}` : ''}` };
  const png = isPng(r.bytes);
  return { label, pass: png && r.ct.startsWith(WANT), detail: `${url} -> ${r.ct}, ${r.bytes.length} bytes, PNG magic: ${png}` };
}

async function rawTx() {
  for (const url of [`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`, `https://api.1sat.app/1sat/tx/${txid}`, `https://ordinals.gorillapool.io/api/tx/${txid}`]) {
    const r = await get(url, 'bytes');
    if (!r.ok) continue;
    const s = new TextDecoder().decode(r.bytes).trim();
    try {
      return /^[0-9a-f]+$/i.test(s) ? Transaction.fromHex(s) : Transaction.fromBinary(Array.from(r.bytes));
    } catch {
      /* try the next source */
    }
  }
  return null;
}

async function verifierRow() {
  const tx = await rawTx();
  if (!tx) return { label: 'BRC-217 verifier (PR #194)', pass: false, detail: 'raw tx not found yet' };
  if (tx.id('hex') !== txid) return { label: 'BRC-217 verifier (PR #194)', pass: false, detail: 'fetched tx does not hash to the txid' };
  const out = tx.outputs[vout];
  if (!out) return { label: 'BRC-217 verifier (PR #194)', pass: false, detail: `no output ${vout}` };
  const v = verifyMintScript(out.lockingScript.toHex());
  return {
    label: 'BRC-217 verifier (PR #194)',
    pass: v.ok && out.satoshis === 1,
    detail: v.ok ? `ok: author ${v.address}, identity_key ${v.identityKey}, MAP ${JSON.stringify(v.map)}, ${out.satoshis} sat` : `REJECTED: ${v.reason}`,
  };
}

const deadline = Date.now() + waitMin * 60_000;
for (let round = 1; ; round++) {
  const rows = await Promise.all([
    indexerRow('api.1sat.app txo', [`https://api.1sat.app/1sat/txo/${opDot}?tags=*&events=true`, `https://api.1sat.app/1sat/txo/tx/${txid}?tags=*`]),
    indexerRow('api.1sat.app ordfs metadata', [`https://api.1sat.app/1sat/ordfs/metadata/${op}`]),
    contentRow('api.1sat.app content', `https://api.1sat.app/content/${op}`),
    indexerRow('gorillapool txo', [`https://ordinals.gorillapool.io/api/txos/${op}`, `https://ordinals.gorillapool.io/api/inscriptions/${op}`]),
    contentRow('gorillapool content', `https://ordinals.gorillapool.io/content/${op}`),
    contentRow('ORDFS (ordfs.network)', `https://ordfs.network/${op}`),
    verifierRow(),
  ]);
  console.log(`\n[${new Date().toISOString()}] round ${round}: ${op}`);
  for (const r of rows) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(28)} ${r.detail}`);
  const all = rows.every((r) => r.pass);
  if (all || Date.now() > deadline) {
    console.log(all ? '\nALL PASS: indexers and ORDFS recognise the BRC-217 layout.' : `\nNot all passing after ${waitMin} min (see FAIL rows).`);
    process.exit(all ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
