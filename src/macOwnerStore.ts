/**
 * The macOS hardware owner store: a Secure Enclave key that needs Touch ID or the Mac password for every signature,
 * and an anchor for it in the login Keychain. See hardwareOwner.ts for the model.
 *
 * How, with no native npm dependency:
 *   - The Secure Enclave key: a ~60-line Swift helper (SWIFT_SOURCE below, CryptoKit + LocalAuthentication).
 *     It's compiled the first time an owner command needs it in a process, with Apple's own /usr/bin/swiftc
 *     (the Xcode Command Line Tools), into a fresh private temp folder that's deleted on exit. Nothing prebuilt
 *     ships in the package and nothing is cached on disk between runs.
 *     CryptoKit's SecureEnclave keys don't live in the Keychain, so an unsigned command-line helper can make and use
 *     them (no entitlements needed). The key is made with `.privateKeyUsage + .userPresence`: the Enclave refuses
 *     every signature until the owner answers the system prompt. Its wrapped blob is useless to anyone else: only
 *     this Mac's Enclave can unwrap it, and only with the prompt answered.
 *   - The anchor: a generic-password item in the login Keychain (service "bwalletx owner key", account "owner"),
 *     written and read with Apple's /usr/bin/security. The public key and blob live in its comment attribute, which
 *     can be read without unlocking the Keychain and without a prompt, so the gate can check it on every spend.
 *   - Every child gets a scrubbed environment (fixed PATH, no DEVELOPER_DIR/TMPDIR/DYLD_*), and the tools are run by
 *     absolute path, so an agent's environment can't swap in its own swiftc or security.
 *
 * Why not `osascript -l JavaScript`: JXA can ask LocalAuthentication for a yes/no, but a yes/no printed by a child
 * process proves nothing to a signature check, and JXA can't reach CryptoKit to make an Enclave key. The owner key
 * itself has to be the thing that needs presence.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { HardwareOwnerStore, HwAnchor, HwAvailability, HwSigner } from './hardwareOwner.js';

const SECURITY = '/usr/bin/security';
const SWIFTC = '/usr/bin/swiftc';
export const KEYCHAIN_SERVICE = 'bwalletx owner key';
export const KEYCHAIN_ACCOUNT = 'owner';
const ANCHOR_TAG = 'bwalletx-owner-anchor/1';
const PROMPT_TIMEOUT_MS = 180_000;

/** The real home directory from the user database, not $HOME (which an agent's shell can change). */
const realHome = () => userInfo().homedir;
const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: realHome(), LANG: 'C', LC_ALL: 'C', ...extra });

export const SWIFT_SOURCE = String.raw`// bwalletx owner helper: a Secure Enclave key that needs user presence for every signature.
import Foundation
import CryptoKit
import LocalAuthentication
import Security

func emit(_ o: [String: Any]) {
  let d = try! JSONSerialization.data(withJSONObject: o, options: [])
  FileHandle.standardOutput.write(d)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
func fail(_ m: String) -> Never { emit(["error": m]); exit(1) }
func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
func presenceACL() -> SecAccessControl {
  var e: Unmanaged<CFError>?
  guard let acl = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &e) else { fail("could not make the access control") }
  return acl
}

let args = CommandLine.arguments
if args.count < 2 { fail("usage: available | generate | session") }
switch args[1] {
case "available":
  emit(["ok": SecureEnclave.isAvailable])
case "generate":
  if !SecureEnclave.isAvailable { fail("this Mac has no Secure Enclave") }
  do {
    let k = try SecureEnclave.P256.Signing.PrivateKey(accessControl: presenceACL())
    emit(["publicKey": hex(k.publicKey.x963Representation), "blob": k.dataRepresentation.base64EncodedString()])
  } catch { fail("could not make the key: \(error.localizedDescription)") }
case "session":
  // line 1: the key blob (base64); line 2: the reason shown in the prompt (base64); then one message per line.
  guard let l1 = readLine(), let blob = Data(base64Encoded: l1) else { fail("no key") }
  guard let l2 = readLine(), let r = Data(base64Encoded: l2), let reason = String(data: r, encoding: .utf8) else { fail("no reason") }
  let ctx = LAContext()
  let key: SecureEnclave.P256.Signing.PrivateKey
  do { key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx) } catch { fail("not a Secure Enclave key of this Mac") }
  // One prompt for the whole session: the evaluated context then authorises each signature with this key.
  let sem = DispatchSemaphore(value: 0)
  var ok = false
  var why = ""
  ctx.evaluateAccessControl(presenceACL(), operation: .useKeySign, localizedReason: reason) { s, err in
    ok = s
    why = err?.localizedDescription ?? ""
    sem.signal()
  }
  sem.wait()
  if !ok { fail("not approved: \(why)") }
  emit(["ready": true, "publicKey": hex(key.publicKey.x963Representation)])
  while let l = readLine() {
    guard let m = Data(base64Encoded: l) else { fail("bad request") }
    do { emit(["sig": hex(try key.signature(for: m).rawRepresentation)]) } catch { fail("the Secure Enclave did not sign: \(error.localizedDescription)") }
  }
default:
  fail("unknown command")
}
`;

const encodeAnchor = (a: HwAnchor) => `${ANCHOR_TAG}:${a.publicKey}:${a.blob}:${a.createdAt}`;
const isAnchor = (a: Partial<HwAnchor> | null): a is HwAnchor =>
  !!a && typeof a.publicKey === 'string' && /^04[0-9a-f]{128}$/.test(a.publicKey) && typeof a.blob === 'string' && /^[A-Za-z0-9+/]+=*$/.test(a.blob) && a.blob.length < 4096 && Number.isFinite(a.createdAt);
export function decodeAnchor(s: string): HwAnchor | null {
  const p = s.split(':');
  if (p.length !== 4 || p[0] !== ANCHOR_TAG) return null;
  const a = { publicKey: p[1], blob: p[2], createdAt: Number(p[3]) };
  return isAnchor(a) ? a : null;
}
/** The comment attribute out of `security find-generic-password` output. */
export const commentFromSecurityOutput = (out: string) => out.match(/"icmt"<blob>="([^"\n]*)"/)?.[1] ?? null;

/** Lines of JSON from a child's stdout, one waiter at a time. Holds the event loop only while waiting. */
class LineReader {
  private buf = '';
  private lines: string[] = [];
  private waiters: { resolve: (s: string) => void; reject: (e: Error) => void }[] = [];
  private ended: Error | null = null;
  constructor(private readonly child: ChildProcess) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.lines.push(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
      }
      this.flush();
    });
    child.on('exit', (code, sig) => {
      if (this.buf.trim()) this.lines.push(this.buf), (this.buf = '');
      this.ended = new Error(`the Touch ID helper stopped (${sig ?? `exit ${code}`})`);
      this.flush();
    });
    child.on('error', (e) => {
      this.ended = e;
      this.flush();
    });
  }
  private hold(on: boolean) {
    for (const h of [this.child, this.child.stdout, this.child.stdin, this.child.stderr] as unknown as { ref?: () => void; unref?: () => void }[]) (on ? h?.ref : h?.unref)?.call(h);
  }
  private flush() {
    while (this.waiters.length && this.lines.length) this.waiters.shift()!.resolve(this.lines.shift()!);
    if (this.ended) while (this.waiters.length) this.waiters.shift()!.reject(this.ended);
    if (!this.waiters.length) this.hold(false);
  }
  next(timeoutMs: number): Promise<Record<string, unknown>> {
    this.hold(true);
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => {
        this.child.kill();
        reject(new Error('no answer from the Touch ID prompt in time'));
      }, timeoutMs);
      this.waiters.push({ resolve: (s) => (clearTimeout(t), resolve(s)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.flush();
    }).then((s) => {
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(s) as Record<string, unknown>;
      } catch {
        throw new Error('the Touch ID helper gave an unreadable answer');
      }
      if (typeof j.error === 'string') throw new Error(j.error);
      return j;
    });
  }
}

export type MacStoreOptions = {
  /** Keychain file. Default: the login keychain under the real home directory. Not settable from env. */
  keychain?: string;
};

export function macOwnerStore(opts: MacStoreOptions = {}): HardwareOwnerStore {
  const keychain = () => opts.keychain ?? join(realHome(), 'Library', 'Keychains', 'login.keychain-db');
  let cache: { at: number; value: HwAnchor | null } | null = null;
  let helper: Promise<string> | null = null;

  const security = (args: string[]) => spawnSync(SECURITY, args, { env: cleanEnv(), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });

  /** Compile the helper once per process, into a private temp folder removed on exit. */
  const helperPath = () =>
    (helper ??= new Promise<string>((resolve, reject) => {
      if (!existsSync(SWIFTC)) return reject(new Error('the Touch ID owner needs the Xcode Command Line Tools: run `xcode-select --install`, then try again'));
      const dir = mkdtempSync(join(tmpdir(), 'bwalletx-owner-'));
      process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
      const src = join(dir, 'main.swift');
      const bin = join(dir, 'bwalletx-owner');
      writeFileSync(src, SWIFT_SOURCE, { mode: 0o600 });
      const c = spawn(SWIFTC, ['-swift-version', '5', '-O', '-module-cache-path', join(dir, 'mc'), '-o', bin, src], { env: cleanEnv({ TMPDIR: dir + '/' }), stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr!.on('data', (d) => void (err += String(d)));
      const t = setTimeout(() => c.kill(), 300_000);
      c.on('error', (e) => (clearTimeout(t), reject(e)));
      c.on('exit', (code) => {
        clearTimeout(t);
        rmSync(src, { force: true });
        if (code === 0 && existsSync(bin)) resolve(bin);
        else reject(new Error(`could not build the Touch ID helper with swiftc (exit ${code}). ${err.split('\n').find((l) => /error/.test(l)) ?? ''}`.trim()));
      });
    }).catch((e) => {
      helper = null;
      throw e;
    }));

  /** Run a one-shot helper command; resolves with its JSON answer. */
  const once = async (cmd: string): Promise<Record<string, unknown>> => {
    const c = spawn(await helperPath(), [cmd], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    return new LineReader(c).next(30_000);
  };

  return {
    kind: 'macos-secure-enclave',
    prompt: 'Touch ID or your Mac password',
    label: 'a Secure Enclave key, anchored in the macOS login Keychain',

    async available(): Promise<HwAvailability> {
      if (process.platform !== 'darwin') return { ok: false, why: 'not a Mac' };
      try {
        const r = await once('available');
        return r.ok === true ? { ok: true } : { ok: false, why: 'this Mac has no Secure Enclave', noHardware: true };
      } catch (e) {
        return { ok: false, why: e instanceof Error ? e.message : String(e) };
      }
    },

    readAnchor(): HwAnchor | null {
      if (cache && Date.now() - cache.at < 2000) return cache.value;
      let value: HwAnchor | null = null;
      // No login keychain at all (some CI images): nothing can be anchored there, same as no entry.
      if (existsSync(keychain())) {
        const r = security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, keychain()]);
        if (r.status === 44) value = null; // errSecItemNotFound
        else if (r.status !== 0) throw new Error(`the macOS Keychain could not be read (security: ${r.error?.message ?? r.signal ?? `exit ${r.status}`})`);
        else {
          const c = commentFromSecurityOutput(r.stdout);
          value = c ? decodeAnchor(c) : null;
          if (!value) throw new Error('the owner entry in the macOS Keychain is unreadable or was edited');
        }
      }
      cache = { at: Date.now(), value };
      return value;
    },

    async generate(): Promise<HwAnchor> {
      const r = await once('generate');
      const a = { publicKey: String(r.publicKey), blob: String(r.blob), createdAt: Date.now() };
      if (!isAnchor(a)) throw new Error('the Touch ID helper made an unreadable key');
      return a;
    },

    saveAnchor(a: HwAnchor) {
      cache = null;
      const r = security(['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-l', KEYCHAIN_SERVICE, '-D', 'bwalletx owner anchor', '-j', encodeAnchor(a), '-w', 'see comment', keychain()]);
      if (r.status === 45) throw new Error('an owner key is already in the macOS Keychain');
      if (r.status !== 0) throw new Error(`could not write the owner key to the macOS Keychain (security exit ${r.status})`);
      const back = this.readAnchor();
      if (back?.publicKey !== a.publicKey) throw new Error('the owner key in the macOS Keychain did not read back the same');
    },

    removeAnchor() {
      cache = null;
      const r = security(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, keychain()]);
      if (r.status !== 0 && r.status !== 44) throw new Error(`could not remove the owner key from the macOS Keychain (security exit ${r.status})`);
    },

    async open(a: HwAnchor, reason: string): Promise<HwSigner> {
      const c = spawn(await helperPath(), ['session'], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
      process.once('exit', () => c.kill());
      const lines = new LineReader(c);
      c.stdin!.on('error', () => {});
      c.stdin!.write(`${a.blob}\n${Buffer.from(`bwalletx: ${reason}`).toString('base64')}\n`);
      let ready: Record<string, unknown>;
      try {
        ready = await lines.next(PROMPT_TIMEOUT_MS);
      } catch (e) {
        c.kill();
        throw e;
      }
      if (ready.publicKey !== a.publicKey) {
        c.kill();
        throw new Error('the Touch ID helper opened a different key');
      }
      return {
        async sign(msg: Buffer) {
          c.stdin!.write(msg.toString('base64') + '\n');
          const r = await lines.next(PROMPT_TIMEOUT_MS);
          if (typeof r.sig !== 'string' || !/^[0-9a-f]{128}$/.test(r.sig)) throw new Error('the Touch ID helper gave an unreadable signature');
          return Buffer.from(r.sig, 'hex');
        },
        close() {
          c.stdin!.end();
          setTimeout(() => c.kill(), 1000).unref();
        },
      };
    },
  };
}
