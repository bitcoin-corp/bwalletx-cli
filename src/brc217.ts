// Copied byte for byte from bitcoin-corp/bwallet PR #194 (branch brc217-mints, b914c1ae) src/mobile/issuer/brc217.ts.
// Keep identical: the test mint must produce exactly what the app will.
import { BigNumber, BSM, ECDSA, Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';

// Same values as issuer.ts (kept here so the two modules don't import each other).
const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
const AIP_PREFIX = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva';
const AIP_ALGORITHM = 'BITCOIN_ECDSA';

/**
 * BRC-217, Authenticated 1Sat Inscription (owner money-ok 26 Oct 2026, public mints only):
 *
 *   <P2PKH lock> <ord envelope> OP_RETURN <MAP section?> [| ] AIP <address> BITCOIN_ECDSA <65-byte sig> "-1"
 *
 * - lock FIRST (R1), one bare OP_RETURN 0x6a (R2/R3, never OP_FALSE OP_RETURN), MAP right after it (R6);
 * - pipe before the author section only when MAP is present (R7); address before algorithm (R8);
 *   raw 65-byte recoverable signature (R9); ASCII "-1" selector (R10);
 * - signed range = every script byte before the author section's delimiter (pipe excluded, 0x6a included),
 *   signed as a Bitcoin Signed Message (§4.2, §4.3).
 *
 * Pure byte work: no wallet, no network. The wallet side (signing through createSignature) is in issuerSign.ts.
 */

const { toArray, toUTF8 } = Utils;
export const OP_RETURN = 0x6a;
const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const PIPE = [0x7c];
export const SELECTOR = '-1';
/** secp256k1 group order. */
const N = new BigNumber('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 16);
const HALF_N = N.ushrn(1);

/** BRC-217 `PUSH(b)`: the minimal push (length byte below 0x4c, else PUSHDATA1/2/4). */
export function push(b: number[]): number[] {
  const n = b.length;
  if (n < 0x4c) return [n, ...b];
  if (n <= 0xff) return [0x4c, n, ...b];
  if (n <= 0xffff) return [0x4d, n & 0xff, n >> 8, ...b];
  return [0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, ...b];
}
const pushStr = (s: string) => push(toArray(s, 'utf8'));

export type Op = { op: number; data?: number[]; start: number; end: number };

/** Tokenise script bytes into opcodes / pushes with byte offsets (throws on a truncated push). */
export function tokenize(bytes: number[], from = 0): Op[] {
  const out: Op[] = [];
  let i = from;
  while (i < bytes.length) {
    const start = i;
    const op = bytes[i++];
    let len = -1;
    if (op >= 0x01 && op < 0x4c) len = op;
    else if (op === 0x4c) len = bytes[i++];
    else if (op === 0x4d) {
      len = bytes[i] | (bytes[i + 1] << 8);
      i += 2;
    } else if (op === 0x4e) {
      len = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
      i += 4;
    }
    if (len >= 0) {
      if (i + len > bytes.length || Number.isNaN(len)) throw new Error('truncated push');
      out.push({ op, data: bytes.slice(i, i + len), start, end: i + len });
      i += len;
    } else out.push({ op, start, end: i });
  }
  return out;
}

const isStr = (o: Op | undefined, s: string) => !!o?.data && toUTF8(o.data) === s;
const isPipe = (o: Op | undefined) => !!o?.data && o.data.length === 1 && o.data[0] === 0x7c;

/** Index of the `OP_FALSE OP_IF "ord"` envelope start and its OP_ENDIF, else null. */
export function findEnvelope(ops: Op[]): { start: number; endif: number } | null {
  for (let i = 0; i + 2 < ops.length; i++) {
    if (ops[i].op === OP_FALSE && !ops[i].data && ops[i + 1].op === OP_IF && isStr(ops[i + 2], 'ord')) {
      for (let j = i + 3; j < ops.length; j++)
        if (ops[j].op === OP_ENDIF && !ops[j].data) return { start: i, endif: j };
      return null;
    }
  }
  return null;
}

/** The MAP section's end (index into `post`) when post[0] is the MAP prefix: walks SET's key/value pairs to a pipe. */
function mapEnd(post: Op[]): number {
  if (!isStr(post[0], MAP_PREFIX) || !isStr(post[1], 'SET')) return -1;
  let k = 2;
  while (k < post.length && !isPipe(post[k])) {
    if (!post[k].data || !post[k + 1]?.data) return -1;
    k += 2;
  }
  return k;
}

/** The author section bytes (§4.1). `pipe` when a metadata section precedes it (R7). */
export function authorSection(address: string, signature: number[], pipe: boolean): number[] {
  if (signature.length !== 65) throw new Error('BRC-217 signature must be 65 raw bytes');
  return [
    ...(pipe ? push(PIPE) : []),
    ...pushStr(AIP_PREFIX),
    ...pushStr(address),
    ...pushStr(AIP_ALGORITHM),
    ...push(signature),
    ...pushStr(SELECTOR),
  ];
}

/** Bitcoin Signed Message hash of the signed range (§4.3). */
export const messageHash = (signedRange: number[]): number[] => BSM.magicHash(signedRange);

/** DER (or any) signature + signer pubkey → the 65-byte low-s compressed recoverable form (§4.3 step 4). */
export function toRecoverable(sig: Signature, pub: PublicKey, hash: number[]): number[] {
  let s = sig.s;
  if (s.cmp(HALF_N) > 0) s = N.sub(s); // R13: low-s
  const low = new Signature(sig.r, s);
  const recid = low.CalculateRecoveryFactor(pub, new BigNumber(hash));
  return low.toCompact(recid, true) as number[];
}

/** Sign a signed range with a raw key (test vectors, tools). RFC 6979 nonce via @bsv/sdk ECDSA. */
export function signRangeWithKey(signedRange: number[], key: PrivateKey): number[] {
  const hash = messageHash(signedRange);
  const sig = ECDSA.sign(new BigNumber(hash), key, true);
  return toRecoverable(sig, key.toPublicKey(), hash);
}

export interface Unsigned {
  /** The signed range: lock || envelope || 0x6a [|| MAP]. */
  signedRange: number[];
  /** A MAP section is present, so the author section takes a leading pipe. */
  hasMap: boolean;
}

/** Assemble the signed range from its parts (MAP given as pushes already encoded, or as key/values). */
export function assemble(lock: number[], envelope: number[], map?: number[] | null): Unsigned {
  return { signedRange: [...lock, ...envelope, OP_RETURN, ...(map ?? [])], hasMap: !!map && map.length > 0 };
}

/** MAP SET section bytes for key/value pairs (minimal pushes, R16). */
export function mapSection(pairs: [string, string][]): number[] {
  return [...pushStr(MAP_PREFIX), ...pushStr('SET'), ...pairs.flatMap(([k, v]) => [...pushStr(k), ...pushStr(v)])];
}

export const finish = (u: Unsigned, address: string, signature: number[]): number[] => [
  ...u.signedRange,
  ...authorSection(address, signature, u.hasMap),
];

/**
 * Re-lay a script @1sat/templates built (`<envelope> <lock> [OP_RETURN MAP…]`, envelope FIRST) as the BRC-217
 * signed range (`<lock> <envelope> OP_RETURN [MAP…]`), adding `extra` MAP pairs at the end of the MAP section.
 * Envelope, lock and MAP bytes are kept exactly; only their order changes. Null when the script is anything
 * else (already signed, a second Bitcom section, no lock, an OP_FALSE OP_RETURN…) so the caller leaves it alone.
 */
export function relayout(scriptHex: string, extra: [string, string][] = []): Unsigned | null {
  let bytes: number[];
  let ops: Op[];
  try {
    bytes = toArray(scriptHex, 'hex');
    ops = tokenize(bytes);
  } catch {
    return null;
  }
  const env = findEnvelope(ops);
  if (!env || env.start !== 0) return null;
  const ret = ops.findIndex((o, i) => i > env.endif && o.op === OP_RETURN && !o.data);
  const lockOps = ops.slice(env.endif + 1, ret < 0 ? ops.length : ret);
  if (!lockOps.length || lockOps[lockOps.length - 1].op === OP_FALSE) return null;
  const envelope = bytes.slice(0, ops[env.endif].end);
  const lock = bytes.slice(lockOps[0].start, lockOps[lockOps.length - 1].end);
  const post = ret < 0 ? [] : ops.slice(ret + 1);
  let map: number[] = [];
  if (post.length) {
    const end = mapEnd(post);
    if (end !== post.length) return null; // only a lone MAP section is ours to sign
    map = bytes.slice(post[0].start, post[post.length - 1].end);
  }
  if (extra.length) {
    const pairs = extra.flatMap(([k, v]) => [...pushStr(k), ...pushStr(v)]);
    map = map.length ? [...map, ...pairs] : mapSection(extra);
  }
  return assemble(lock, envelope, map);
}

export type Brc217Verdict =
  | { ok: true; address: string; map: Record<string, string>; signedRange: number[] }
  | { ok: false; reason: string };

/** Address of a recovered key in the compression form the header says. */
const addressOf = (pub: PublicKey, compressed: boolean) =>
  compressed ? pub.toAddress() : Utils.toBase58Check(Hash.hash160(pub.encode(false) as number[]), [0]);

/** Verify one BRC-217 signature over a signed range (§5 step 6). Fails closed. */
export function verifySignature(signedRange: number[], signature: number[], address: string): boolean {
  try {
    if (signature.length !== 65) return false;
    const header = signature[0];
    if (header < 0x1b || header > 0x22) return false;
    const r = new BigNumber(signature.slice(1, 33));
    const s = new BigNumber(signature.slice(33, 65));
    if (r.isZero() || s.isZero() || r.cmp(N) >= 0 || s.cmp(N) >= 0 || s.cmp(HALF_N) > 0) return false;
    const recid = (header - 27) & 3;
    const compressed = header >= 0x1f;
    const hash = new BigNumber(messageHash(signedRange));
    const pub = new Signature(r, s).RecoverPublicKey(recid, hash);
    if (!pub || pub.isInfinity()) return false;
    return addressOf(pub, compressed) === address;
  } catch {
    return false;
  }
}

/**
 * Read and verify a BRC-217 output script (§5): structural parse (lock, envelope, bare OP_RETURN, MAP?, author
 * section at its structural position, never a scan for the AIP prefix), then public-key recovery.
 */
export function verifyBrc217(scriptHex: string): Brc217Verdict {
  let bytes: number[];
  let ops: Op[];
  try {
    bytes = toArray(scriptHex, 'hex');
    ops = tokenize(bytes);
  } catch {
    return { ok: false, reason: 'bad script' };
  }
  const env = findEnvelope(ops);
  if (!env) return { ok: false, reason: 'no inscription' };
  if (env.start === 0) return { ok: false, reason: 'not lock-first' };
  const after = ops[env.endif + 1];
  if (after?.op === OP_FALSE && !after.data && ops[env.endif + 2]?.op === OP_RETURN)
    return { ok: false, reason: 'OP_FALSE OP_RETURN: not a transferable inscription' }; // R15
  if (after?.op !== OP_RETURN || after.data) return { ok: false, reason: 'no bare OP_RETURN after the envelope' };
  const post = ops.slice(env.endif + 2);
  let at = 0;
  const map: Record<string, string> = {};
  if (isStr(post[0], MAP_PREFIX)) {
    const end = mapEnd(post);
    if (end < 0 || !isPipe(post[end])) return { ok: false, reason: 'no author section' };
    for (let k = 2; k < end; k += 2) map[toUTF8(post[k].data!)] = toUTF8(post[k + 1].data!);
    at = end + 1;
  }
  const [prefix, addr, algo, sig, sel] = post.slice(at, at + 5);
  if (!isStr(prefix, AIP_PREFIX)) return { ok: false, reason: 'no author section' };
  if (!addr?.data || !/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(toUTF8(addr.data)))
    return { ok: false, reason: 'no signing address' };
  if (!isStr(algo, AIP_ALGORITHM)) return { ok: false, reason: 'unknown algorithm' };
  if (!isStr(sel, SELECTOR)) return { ok: false, reason: 'unknown selector' };
  const trailing = post[at + 5];
  if (trailing && !isPipe(trailing)) return { ok: false, reason: 'junk after the author section' };
  if (!sig?.data || sig.data.length !== 65) return { ok: false, reason: 'signature is not 65 raw bytes' };
  const delimiter = at > 0 ? post[at - 1] : prefix;
  const signedRange = bytes.slice(0, delimiter.start);
  const address = toUTF8(addr.data);
  if (!verifySignature(signedRange, sig.data, address)) return { ok: false, reason: 'invalid signature' };
  return { ok: true, address, map, signedRange };
}
