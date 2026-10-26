#!/usr/bin/env node
/**
 * ONE BRC-217 test mint (owner-approved 26 Oct 2026) from a CLI agent account, to check that the live 1Sat
 * indexer and ORDFS recognise the bitcoin-corp/bwallet PR #194 layout before that PR merges:
 *
 *   <P2PKH lock> <ord envelope image/png> OP_RETURN MAP SET app bWallet type ord name "BRC-217 test"
 *     identity_key <hex> | AIP <address> BITCOIN_ECDSA <65-byte sig> "-1"
 *
 * Signed as issuerSign.ts withBrc217 does (identity key's [2,'bwallet issuer'] / '1' / anyone child, via the
 * wallet's createSignature). The 1-sat output is locked to the account's own ordinals address.
 *
 * DRY by default: builds and signs the tx with noSend, prints txid / script hex / fee / total, then aborts it
 * so nothing is held or broadcast. `--broadcast` sends exactly that tx (sendWith). Hard cap: 10,000 sats.
 *
 *   node scripts/brc217-test-mint.mjs --account opns              # dry run (asks for the passphrase)
 *   node scripts/brc217-test-mint.mjs --account opns --broadcast  # the real mint
 *   node scripts/brc217-test-mint.mjs --offline                   # no wallet: throwaway key, size + fee estimate
 *
 * The passphrase comes from BWALLETX_PASSPHRASE or the terminal prompt (same path as `bwalletx opns mint`).
 * Needs `pnpm build` first (imports dist/).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateKey, Transaction, Utils } from '@bsv/sdk';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (f) => join(root, 'dist', f);
const { selfCheckVectorA, signWithKey, signWithWallet, testMintParts, verifyMintScript } = await import(dist('brc217Mint.js'));

const CAP_SATS = 10_000;
const NAME = 'BRC-217 test';
const DEFAULT_PNG = '/Volumes/2026/Projects/bwalletx-site-brand-master/brand/master/b/png/b-square-48.png';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const broadcast = flag('--broadcast');
const offline = flag('--offline');
const account = opt('--account');
const pngPath = opt('--png') ?? DEFAULT_PNG;
const die = (m) => {
  console.error(`ERROR: ${m}`);
  process.exit(1);
};

// 1. Vector self-check before anything else.
console.log(`BRC-217 vector A self-check: PASS (script sha256 ${selfCheckVectorA()})`);

// 2. Content.
const png = Array.from(readFileSync(pngPath));
if (png.length > 2048) die(`PNG is ${png.length} bytes; the test mint takes ≤ 2 KB`);
if (Utils.toHex(png.slice(0, 8)) !== '89504e470d0a1a0a') die(`${pngPath} is not a PNG`);
console.log(`Content: ${pngPath} (${png.length} bytes, image/png)`);

const report = (scriptHex, author, identityKey, ordAddress) => {
  const v = verifyMintScript(scriptHex);
  if (!v.ok) die(`built script failed its own BRC-217 verification: ${v.reason}`);
  console.log(`Lock (ordinals address): ${ordAddress}`);
  console.log(`identity_key:            ${identityKey}`);
  console.log(`AIP author address:      ${author}  (issuer child of identity_key: verified)`);
  console.log(`MAP:                     ${JSON.stringify(v.map)}`);
  console.log(`Script: ${scriptHex.length / 2} bytes`);
  console.log(`Script hex:\n${scriptHex}`);
};

if (offline) {
  // No wallet, no passphrase: a throwaway identity, to show the layout, size and an estimated fee.
  const id = PrivateKey.fromRandom();
  const ordAddress = PrivateKey.fromRandom().toAddress();
  const parts = testMintParts({ address: ordAddress, contentType: 'image/png', body: png, name: NAME, identityKey: id.toPublicKey().toString() });
  const { scriptHex, author } = signWithKey(id, parts);
  report(scriptHex, author, id.toPublicKey().toString(), `${ordAddress} (throwaway)`);
  const scriptLen = scriptHex.length / 2;
  // 1 P2PKH input (148) + version/locktime/counts (10) + our output (8 + 3 varint + script) + change (34).
  const size = 10 + 148 + 8 + 3 + scriptLen + 34;
  const fee = Math.ceil((size * 100) / 1000);
  console.log(`Estimated tx: ~${size} bytes, fee ~${fee} sats at 100 sat/kB, total cost ~${fee + 1} sats (cap ${CAP_SATS}). OFFLINE: nothing built against a wallet, nothing sent.`);
  process.exit(0);
}

if (!account) die('--account <name> is required (e.g. --account opns), or use --offline');

const { brc100Account } = await import(dist('brc100Actions.js'));
const { withSpendLock } = await import(dist('store.js'));

const { name, keys, w } = await brc100Account(account);
let exitCode = 0;
try {
  await withSpendLock(name, async () => {
    if (w.syncProofs) await w.syncProofs().catch(() => undefined); // avoid "Maximum BEEF depth exceeded"
    const wallet = w.wallet;
    const ordAddress = PrivateKey.fromWif(keys.ordPk).toAddress();
    const parts = testMintParts({ address: ordAddress, contentType: 'image/png', body: png, name: NAME, identityKey: w.identityKey });
    const { scriptHex, author } = await signWithWallet(wallet, parts);
    report(scriptHex, author, w.identityKey, ordAddress);

    const r = await wallet.createAction({
      description: 'BRC-217 test mint',
      outputs: [{ lockingScript: scriptHex, satoshis: 1, outputDescription: 'BRC-217 test inscription' }],
      options: { randomizeOutputs: false, noSend: true, acceptDelayedBroadcast: false },
    });
    if (!r.txid || !r.tx) throw new Error('wallet returned no signed tx');
    const tx = Transaction.fromAtomicBEEF(r.tx);
    const inSats = tx.inputs.reduce((s, i) => s + (i.sourceTransaction?.outputs[i.sourceOutputIndex]?.satoshis ?? NaN), 0);
    const outSats = tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0);
    const fee = inSats - outSats;
    const total = fee + 1;
    const ok0 = tx.outputs[0]?.lockingScript.toHex() === scriptHex && tx.outputs[0].satoshis === 1;
    console.log(`\ntxid-to-be: ${r.txid}   (inscription outpoint ${r.txid}_0)`);
    console.log(`tx: ${tx.toBinary().length} bytes, ${tx.inputs.length} input(s), ${tx.outputs.length} output(s); output 0 is the inscription: ${ok0}`);
    console.log(`fee: ${fee} sats; total cost: ${total} sats (fee + the 1 sat, which stays on our ordinals address); cap ${CAP_SATS}`);

    const abort = async () => {
      try {
        await wallet.abortAction({ reference: r.txid });
      } catch (e) {
        console.error(`(could not release the dry-run tx: ${e instanceof Error ? e.message : e}; it was never broadcast)`);
      }
    };
    if (!ok0 || !Number.isFinite(fee) || fee < 0) {
      await abort();
      throw new Error('could not account for the tx (output 0 or fee); aborted, nothing sent');
    }
    if (total > CAP_SATS) {
      await abort();
      throw new Error(`total ${total} sats is above the ${CAP_SATS}-sat cap; aborted, nothing sent`);
    }
    if (!broadcast) {
      await abort();
      console.log('\nDRY RUN: nothing broadcast. Re-run with --broadcast to send (a fresh build; the txid will differ).');
      return;
    }
    const s = await wallet.createAction({ description: 'BRC-217 test mint (send)', options: { sendWith: [r.txid], acceptDelayedBroadcast: false } });
    const res = (s.sendWithResults ?? []).find((x) => x.txid === r.txid);
    console.log(`\nBROADCAST: ${r.txid} -> ${res?.status ?? 'submitted'}`);
    if (res && res.status === 'failed') throw new Error('broadcast failed');
    console.log(`Check it: node scripts/brc217-check.mjs ${r.txid}`);
  });
} catch (e) {
  console.error(`ERROR: ${e instanceof Error ? e.message : e}`);
  if (/insufficient|funds/i.test(String(e))) console.error(`Hint: move the account's BSV into its BRC-100 wallet first: bwalletx brc100 fund --account ${name}`);
  exitCode = 1;
} finally {
  await w.sendWaiting().catch(() => undefined);
  await w.close().catch(() => undefined);
}
process.exit(exitCode);
