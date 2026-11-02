/**
 * The human gate for LOOSENING actions (0.6.0). See owner.ts for the signed-settings model.
 *
 * Loosening (raise or clear a cap, raise or clear a rate limit or approve-above, resume, strategy load --live,
 * key import/new, login/pair, brc100 migrate, starting serve) needs ALL of:
 *   1. not running under the MCP server (in-process flag, or BWALLETX_UNDER_MCP inherited by children);
 *   2. an interactive terminal: stdin AND stdout are TTYs (piped input is refused);
 *   3. not an agent's own shell that says so (CLAUDECODE etc.; a speed bump, not a wall);
 *   4. the OWNER PIN, typed at a hidden prompt. Never read from env or arguments. BWALLETX_YES is ignored.
 * Tightening (stop, lowering a cap, rate limit or approve-above) needs none of this, from anywhere.
 *
 * Limits, stated plainly: this stops an agent that runs `bwalletx cap <acct> off` or edits the JSON. It can't stop
 * an agent that has a shell AND your PIN AND fakes a terminal, and a key-file account's keys are only as safe as
 * BWALLETX_PASSPHRASE (which an agent that can read your MCP config can read). For large spends the real control
 * is approve-above on a paired account: the phone approves, and nothing in this file can approve a spend.
 *
 * 0.7.0: on a Mac, step 4 is Touch ID or the Mac password instead of a PIN (hardwareOwner.ts). The owner key is
 * a Secure Enclave key that refuses to sign without the prompt, and a Keychain anchor says which key is the owner,
 * so faking a terminal, unsetting CLAUDECODE or deleting ~/.bwalletx/owner*.json no longer gets an agent an owner
 * of its own. Elsewhere (Linux, CI) the PIN stays, and `owner status` says the gate is software-only.
 */
import { decryptKeyFile, validateKeyFile } from './keyfile.js';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { hardwareStore, type HardwareOwnerStore, type HwAnchor, type HwSigner } from './hardwareOwner.js';
import {
  bodyOf,
  createOwner,
  hwOwnerFile,
  ownerPath,
  pinSigner,
  PRESENCE_DOMAIN,
  readHwOwnerFile,
  settingsPath,
  verifyOwnerSig,
  writeSignedSettings,
  type OwnerSigner,
  type SettingsFile,
  effectiveAccount,
  hashLoaded,
  pinProblem,
  readOwnerFile,
  readOwnerState,
  recoverAfterStop,
  restrictiveAccount,
  tighterRate,
  tighterUsd,
  unlockOwner,
  writeOwnerFile,
  writeSettings,
  SETTINGS_FORMAT,
  type OwnerState,
  type ScryptParams,
  type SettingsBody,
  type SignedAccount,
} from './owner.js';
import { DEFAULT_DAILY_CAP_USD, RATE_LIMIT_PER_HOUR } from './limits.js';
import { confirm as ttyConfirm, hiddenPrompt } from './passphrase.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allStopped, appendLog, getLoaded, home, readConfig, readKeyFile, resolveAccount, setAllStopped, updateAccount, type AccountConfig } from './store.js';

export type OwnerEnv = {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  underMcp: boolean;
  /** Name of an env marker that says an AI agent's shell runs us (e.g. CLAUDECODE), else null. */
  agentShell: string | null;
  /** Hidden prompt. The only way a PIN gets in. */
  prompt: (q: string) => Promise<string>;
  confirm: (q: string) => Promise<boolean>;
  say: (s: string) => void;
  /** scrypt cost for a NEW PIN; tests pass a small one. Never read from env. */
  scrypt?: ScryptParams;
};

let mcpMode = false;
/** Called by `bwalletx mcp` before it serves anything: from then on every loosening action is refused. */
export const markUnderMcp = () => {
  mcpMode = true;
  process.env.BWALLETX_UNDER_MCP = '1';
};

const AGENT_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];
export const defaultOwnerEnv = (): OwnerEnv => ({
  stdinTTY: !!process.stdin.isTTY,
  stdoutTTY: !!process.stdout.isTTY,
  underMcp: mcpMode || process.env.BWALLETX_UNDER_MCP === '1',
  agentShell: AGENT_MARKERS.find((k) => process.env[k]) ?? null,
  prompt: hiddenPrompt,
  confirm: ttyConfirm,
  say: (s) => void process.stderr.write(s + '\n'),
});

export class OwnerRefused extends Error {
  override name = 'OwnerRefused';
}

/** Checks 1–3. Throws OwnerRefused with what to do instead. */
export function assertHuman(what: string, env: OwnerEnv) {
  if (env.underMcp) throw new OwnerRefused(`Refused under MCP: "${what}" loosens a safety setting, so only the owner can do it, in their own terminal.`);
  if (!env.stdinTTY || !env.stdoutTTY)
    throw new OwnerRefused(`Refused: "${what}" needs the owner at an interactive terminal (stdin and stdout must be a TTY; piped input and BWALLETX_YES don't count).`);
  if (env.agentShell) throw new OwnerRefused(`Refused: "${what}" looks like it runs in an AI agent's shell (${env.agentShell} is set). Run it yourself in your own terminal.`);
}

const logAll = (action: string, detail: string) => {
  for (const n of Object.keys(readConfig().accounts)) appendLog(n, { at: Date.now(), action, detail, usd: 0 });
};
const stopFileExists = () => existsSync(join(home(), 'STOP'));

/** An account's settings as config.json has them, ready to sign (when the owner has reviewed them). */
export const accountFromConfig = (a: AccountConfig): SignedAccount => {
  const l = getLoaded(a.name);
  return {
    dailyCapUsd: a.dailyCapUsd ?? null,
    ratePerHour: a.ratePerHour ?? null,
    approveAboveUsd: a.approveAboveUsd ?? null,
    stopped: !!a.stopped,
    liveStrategy: l?.mode === 'live' ? hashLoaded(l) : null,
  };
};
/** The restrictive version: defaults clamp config.json, no live strategy. Used when nothing signed can be trusted. */
const restrictiveFromConfig = (a: AccountConfig | undefined, stopped = false): SignedAccount => ({
  ...restrictiveAccount(stopped || !!a?.stopped),
  dailyCapUsd: tighterUsd(DEFAULT_DAILY_CAP_USD, a?.dailyCapUsd),
  ratePerHour: tighterRate(RATE_LIMIT_PER_HOUR, a?.ratePerHour),
  approveAboveUsd: a?.approveAboveUsd ?? null,
});

export type BaseSource = 'signed' | 'recovered' | 'defaults';

/** A stopped body (signature dropped by `stop`) for this owner key, with stopAll kept on. Unverified: see resumeAll. */
const stoppedBody = (s: SettingsFile | null, publicKey: string): SettingsBody | null =>
  s && !s.sig && s.broken && s.publicKey === publicKey ? { ...structuredClone(bodyOf(s)), stopAll: true } : null;

/** Holds an owner signer for one command (the PIN key in memory, or a Touch ID session). Only made by requireOwner / setupOwner. */
export class OwnerSession {
  /** Hardware owner only: the owner looked at the values from before a `stop` and chose to keep them (resumeAll). */
  acceptStopped = false;
  constructor(private readonly signer: OwnerSigner) {}

  get publicKey() {
    return this.signer.publicKey;
  }
  get kind() {
    return this.signer.kind;
  }

  /** What to build the next signed settings on: the verified record, the record from before a `stop`, or safe defaults. */
  base(st: OwnerState = readOwnerState()): { body: SettingsBody; source: BaseSource } {
    if (st.state === 'ok' && st.settings.publicKey === this.publicKey) return { body: structuredClone(bodyOf(st.settings)), source: 'signed' };
    const settings = st.state === 'tampered' ? st.settings : null;
    // PIN owner: Ed25519 is deterministic, so re-signing proves the values are the ones signed before the stop.
    // Hardware owner: ECDSA isn't, so only the owner's explicit OK (acceptStopped) keeps them.
    const rec = this.signer.priv ? recoverAfterStop(settings, this.signer.priv, this.publicKey) : this.acceptStopped ? stoppedBody(settings, this.publicKey) : null;
    if (rec) return { body: structuredClone(rec), source: 'recovered' };
    const cfg = readConfig();
    const accounts: Record<string, SignedAccount> = {};
    for (const [n, a] of Object.entries(cfg.accounts)) accounts[n] = restrictiveFromConfig(a);
    return {
      body: { format: SETTINGS_FORMAT, publicKey: this.publicKey, seq: settings?.seq ?? 0, signedAt: 0, stopAll: st.state === 'tampered' || stopFileExists(), accounts },
      source: 'defaults',
    };
  }

  /** Sign and save the next settings. Returns where the base came from. */
  async update(mut: (b: SettingsBody) => void): Promise<BaseSource> {
    const { body, source } = this.base();
    mut(body);
    body.seq += 1;
    body.signedAt = Date.now();
    body.publicKey = this.publicKey;
    await writeSignedSettings(body, this.signer);
    return source;
  }

  /** Ends a Touch ID session (the PIN key just goes out of scope). */
  close() {
    this.signer.close?.();
  }

  /** The account entry in a body, created from config.json (restrictive) when missing. */
  static entry(b: SettingsBody, name: string): SignedAccount {
    return (b.accounts[name] ??= restrictiveFromConfig(readConfig().accounts[name]));
  }
}

export const SOFTWARE_ONLY_WARNING =
  'The owner gate on this machine is software-only (a PIN typed at a terminal). An AI agent with a shell can fake a terminal, so if it learns your PIN, or sets one before you do, it can loosen your limits. For large spends use approve-above on a paired phone account (the phone approves).';

/** The anchor, or a refusal when the Keychain can't be read (never assume "no owner" when unsure). */
function readAnchorOrRefuse(hw: HardwareOwnerStore): HwAnchor | null {
  try {
    return hw.readAnchor();
  } catch (e) {
    throw new OwnerRefused(`Refused: ${e instanceof Error ? e.message : String(e)}. bwalletx can't tell whether a Touch ID owner exists, so nothing is loosened.`);
  }
}

/**
 * One presence prompt (Touch ID / Mac password), then proof: the key signs a fresh challenge and we check it against
 * the anchor's public key. A helper that only says "yes" proves nothing; only the Enclave key can make that signature.
 */
async function presenceSigner(hw: HardwareOwnerStore, anchor: HwAnchor, what: string, env: OwnerEnv): Promise<OwnerSigner> {
  env.say(`Confirm with ${hw.prompt} to ${what}.`);
  let session: HwSigner;
  try {
    session = await hw.open(anchor, what);
  } catch (e) {
    throw new OwnerRefused(`Not approved (${e instanceof Error ? e.message : String(e)}). Nothing changed.`);
  }
  const challenge = Buffer.concat([Buffer.from(`${PRESENCE_DOMAIN}${what}\n`), randomBytes(32)]);
  try {
    if (!verifyOwnerSig(challenge, await session.sign(challenge), anchor.publicKey)) throw new Error('its signature did not verify');
  } catch (e) {
    session.close();
    throw new OwnerRefused(`The owner key did not prove the owner is here (${e instanceof Error ? e.message : String(e)}). Nothing changed.`);
  }
  return { publicKey: anchor.publicKey, kind: 'hardware', sign: (m) => session.sign(m), close: () => session.close() };
}

/** Refuse a PIN that opens one of the account key files (it would be the MCP passphrase). */
async function pinIsAKeyPassphrase(pin: string): Promise<boolean> {
  if (process.env.BWALLETX_PASSPHRASE && pin === process.env.BWALLETX_PASSPHRASE) return true;
  const names = Object.values(readConfig().accounts)
    .filter((a) => a.kind !== 'paired')
    .map((a) => a.name)
    .slice(0, 3);
  for (const n of names) {
    try {
      const raw = readKeyFile(n);
      if (!raw) continue;
      await decryptKeyFile(validateKeyFile(raw), pin);
      return true;
    } catch {
      /* wrong passphrase for this file: good */
    }
  }
  return false;
}

const describe = (a: SignedAccount | AccountConfig, live?: string | null) => {
  const r = a.ratePerHour ?? null;
  return `cap ${a.dailyCapUsd == null ? 'none' : `$${a.dailyCapUsd}/day`}, rate ${r === 0 ? 'off' : `${r ?? RATE_LIMIT_PER_HOUR}/hour`}, approve above ${a.approveAboveUsd == null ? 'none' : `$${a.approveAboveUsd}`}${a.stopped ? ', STOPPED' : ''}${live ? `, live strategy ${live}` : ''}`;
};

/** Show config.json and ask the owner to approve it. Returns the accounts to sign. */
async function reviewConfig(env: OwnerEnv, prompt: string): Promise<{ approved: boolean; accounts: Record<string, SignedAccount> }> {
  const cfg = readConfig();
  const names = Object.keys(cfg.accounts);
  if (!names.length) return { approved: true, accounts: {} };
  env.say('Settings in config.json:');
  for (const n of names) {
    const l = getLoaded(n);
    env.say(`  ${n}: ${describe(cfg.accounts[n], l?.mode === 'live' ? `"${l.strategy.name}"` : null)}`);
  }
  const approved = await env.confirm(prompt);
  const accounts: Record<string, SignedAccount> = {};
  for (const n of names) accounts[n] = approved ? accountFromConfig(cfg.accounts[n]) : restrictiveFromConfig(cfg.accounts[n]);
  return { approved, accounts };
}

async function newPin(env: OwnerEnv): Promise<string> {
  const pin = await env.prompt(`New owner PIN (at least 8 characters; NOT your wallet passphrase): `);
  const bad = pinProblem(pin);
  if (bad) throw new OwnerRefused(bad);
  if (await pinIsAKeyPassphrase(pin)) throw new OwnerRefused('The owner PIN must be different from the wallet passphrase (an agent may be able to read that one).');
  if ((await env.prompt('Type it again: ')) !== pin) throw new OwnerRefused("The two PINs don't match. Nothing changed.");
  return pin;
}

/** A first signed baseline for a new owner key. */
async function signBaseline(env: OwnerEnv, signer: OwnerSigner, st: OwnerState) {
  const { approved, accounts } = await reviewConfig(env, 'Approve these settings as the owner? (No = safe defaults: $10/day cap, 30/hour, strategies on paper)');
  await writeSignedSettings(
    {
      format: SETTINGS_FORMAT,
      publicKey: signer.publicKey,
      seq: (st.state === 'tampered' ? (st.settings?.seq ?? 0) : 0) + 1,
      signedAt: Date.now(),
      stopAll: stopFileExists(),
      accounts,
    },
    signer,
  );
  return approved;
}

/** Hardware setup: new Enclave key, one presence prompt, then the anchor, owner.json and a signed baseline. */
async function setupHardware(hw: HardwareOwnerStore, st: OwnerState, env: OwnerEnv): Promise<OwnerSession> {
  const anchor = await hw.generate();
  const signer = await presenceSigner(hw, anchor, 'set up the bwalletx owner', env);
  try {
    hw.saveAnchor(anchor);
    writeOwnerFile(hwOwnerFile(anchor, hw.kind));
    const approved = await signBaseline(env, signer, st);
    logAll('owner-setup', `Owner set up with ${hw.prompt}; settings signed (${approved ? 'as configured' : 'safe defaults'})`);
    env.say(`Owner set up. Loosening a safety setting now needs ${hw.prompt}. Settings signed ${approved ? 'as configured' : 'at the safe defaults'}.`);
  } catch (e) {
    signer.close?.();
    throw e;
  }
  return new OwnerSession(signer);
}

/**
 * First-time setup (or after the owner files were lost). On a Mac with a Secure Enclave the owner is a Touch ID key
 * and there is no PIN; elsewhere it's the 0.6.0 PIN. Refused when an owner already exists, including a Touch ID key
 * in the Keychain whose owner files were deleted.
 */
export async function setupOwner(env: OwnerEnv = defaultOwnerEnv()): Promise<OwnerSession> {
  assertHuman('set up the owner', env);
  const hw = hardwareStore();
  if (hw && readAnchorOrRefuse(hw))
    throw new OwnerRefused(
      'Refused: a Touch ID owner key is already in the macOS Keychain, so setup is refused, even if ~/.bwalletx/owner*.json are gone (that only keeps everything stopped). `bwalletx resume` or `bwalletx owner sign` (Touch ID) restores the settings; `bwalletx owner reset` (Touch ID) removes the key to start over.',
    );
  if (readOwnerFile()) throw new OwnerRefused(`An owner PIN is already set. Change it with \`bwalletx owner change\`${hw ? ', or move it to Touch ID with `bwalletx owner upgrade`' : ''}.`);
  const st = readOwnerState();
  if (st.state === 'tampered')
    env.say(`WARNING: the owner files can't be verified (${st.why}). If you didn't do this, something edited ~/.bwalletx. A new owner replaces them.`);
  if (hw) {
    env.say(`Setting up the owner with ${hw.prompt}. bwalletx first builds a small helper with Apple's swiftc (a few seconds).`);
    const avail = await hw.available();
    if (avail.ok) return setupHardware(hw, st, env);
    // Only a definite "no Secure Enclave" falls back to a PIN. Anything else (no swiftc, a failed build) could be
    // caused by an agent, and a PIN it could then set itself is exactly the hole this closes.
    if (!avail.noHardware)
      throw new OwnerRefused(`Refused: this Mac can't make a Touch ID owner key right now (${avail.why}). bwalletx doesn't fall back to a PIN on a Mac. Until then every account runs at the safe defaults.`);
    env.say(`This Mac has no Secure Enclave, so the owner is a PIN. ${SOFTWARE_ONLY_WARNING}`);
  } else env.say(`WARNING: ${SOFTWARE_ONLY_WARNING}`);
  env.say('Set your owner PIN. bwalletx asks for it, at a hidden prompt, whenever a safety setting is loosened.');
  const pin = await newPin(env);
  const { file, priv } = createOwner(pin, env.scrypt);
  writeOwnerFile(file);
  const signer = pinSigner(priv, file.publicKey);
  const approved = await signBaseline(env, signer, st);
  logAll('owner-setup', `Owner PIN set; settings signed (${approved ? 'as configured' : 'safe defaults'})`);
  env.say(`Owner PIN set. Settings signed ${approved ? 'as configured' : 'at the safe defaults'}.`);
  return new OwnerSession(signer);
}

/** Checks 1–4 for a loosening action. Offers first-time setup when no owner exists yet. */
export async function requireOwner(what: string, env: OwnerEnv = defaultOwnerEnv()): Promise<OwnerSession> {
  assertHuman(what, env);
  const hw = hardwareStore();
  const anchor = hw ? readAnchorOrRefuse(hw) : null;
  if (hw && anchor) {
    const signer = await presenceSigner(hw, anchor, what, env);
    // owner.json only mirrors the anchor. The owner just proved presence, so put it back if it was deleted or swapped.
    if (readHwOwnerFile()?.publicKey !== anchor.publicKey) writeOwnerFile(hwOwnerFile(anchor, hw.kind));
    return new OwnerSession(signer);
  }
  if (readHwOwnerFile()) {
    env.say(`"${what}" needs the owner, and the Touch ID owner key is gone from the Keychain. Set up a new owner first.`);
    return setupOwner(env);
  }
  const owner = readOwnerFile();
  if (!owner) {
    env.say(`"${what}" needs the owner, and none is set up yet.`);
    return setupOwner(env);
  }
  const pin = await env.prompt(`Owner PIN to ${what}: `);
  const k = pin ? unlockOwner(pin, owner) : null;
  if (!k) throw new OwnerRefused('Wrong owner PIN. Nothing changed.');
  return new OwnerSession(pinSigner(k.priv, k.publicKey));
}

const say = (env: OwnerEnv, source: BaseSource) => {
  if (source === 'defaults') env.say('Note: the signed settings could not be verified, so the other limits were reset to the safe defaults. Review with `bwalletx owner status`; approve config.json with `bwalletx owner sign`.');
};
const logOne = (name: string, action: string, detail: string) => appendLog(name, { at: Date.now(), action, detail, usd: 0 });

// ---- the settings commands (shared by the CLI and tests) ----

/** `bwalletx cap <account> <usd|off>`. Lowering: no PIN. Raising or clearing: owner PIN. */
export async function setCap(name: string, v: string, env: OwnerEnv = defaultOwnerEnv()): Promise<string> {
  const a = resolveAccount(name);
  const cap = v === 'off' ? null : Number(v.replace(/^\$/, ''));
  if (cap !== null && !(cap > 0)) throw new Error('Cap must be a positive number or "off"');
  const eff = effectiveAccount(a);
  if (cap !== null && (eff.dailyCapUsd === null || cap <= eff.dailyCapUsd)) {
    updateAccount(a.name, { dailyCapUsd: cap });
    logOne(a.name, 'cap', `Daily cap lowered to $${cap}`);
    return `${a.name}: daily cap $${cap}`;
  }
  const s = await requireOwner(cap === null ? `clear ${a.name}'s daily cap` : `raise ${a.name}'s daily cap to $${cap}`, env);
  updateAccount(a.name, { dailyCapUsd: cap });
  say(env, await s.update((b) => void (OwnerSession.entry(b, a.name).dailyCapUsd = cap)));
  s.close();
  logOne(a.name, 'cap', cap === null ? 'Daily cap cleared (owner PIN)' : `Daily cap raised to $${cap} (owner PIN)`);
  return cap === null ? `${a.name}: no daily cap` : `${a.name}: daily cap $${cap}`;
}

const rateOrder = (n: number | null) => (n === null ? RATE_LIMIT_PER_HOUR : n === 0 ? Infinity : n);
/** `bwalletx ratelimit <account> <n|off|default>`. Lowering: no PIN. Raising or "off": owner PIN. */
export async function setRateLimit(name: string, v: string, env: OwnerEnv = defaultOwnerEnv()): Promise<string> {
  const a = resolveAccount(name);
  const n = v === 'off' ? 0 : v === 'default' ? null : Number(v);
  if (n !== null && !(Number.isInteger(n) && n >= 0)) throw new Error('Rate must be a whole number, "off" or "default"');
  const msg = n === 0 ? `${a.name}: no rate limit` : n ? `${a.name}: at most ${n} spending actions per hour` : `${a.name}: default rate limit`;
  if (rateOrder(n) <= rateOrder(effectiveAccount(a).ratePerHour)) {
    updateAccount(a.name, { ratePerHour: n });
    logOne(a.name, 'ratelimit', `Rate limit lowered: ${msg}`);
    return msg;
  }
  const s = await requireOwner(n === 0 ? `turn off ${a.name}'s rate limit` : `raise ${a.name}'s rate limit to ${n ?? RATE_LIMIT_PER_HOUR}/hour`, env);
  updateAccount(a.name, { ratePerHour: n });
  say(env, await s.update((b) => void (OwnerSession.entry(b, a.name).ratePerHour = n)));
  s.close();
  logOne(a.name, 'ratelimit', `${msg} (owner PIN)`);
  return msg;
}

/** `bwalletx approve-above <account> <usd|off>`. Lowering: no PIN. Raising or clearing: owner PIN. */
export async function setApproveAbove(name: string, v: string, env: OwnerEnv = defaultOwnerEnv()): Promise<string> {
  const a = resolveAccount(name);
  const t = v === 'off' ? null : Number(v.replace(/^\$/, ''));
  if (t !== null && !(t >= 0)) throw new Error('Threshold must be a number of USD (0 or more) or "off"');
  const msg = t !== null ? `${a.name}: spends over $${t} need owner approval` : `${a.name}: no approval threshold`;
  const eff = effectiveAccount(a);
  if (t !== null && (eff.approveAboveUsd === null || t <= eff.approveAboveUsd)) {
    updateAccount(a.name, { approveAboveUsd: t });
    logOne(a.name, 'approve-above', msg);
    return msg;
  }
  const s = await requireOwner(t === null ? `clear ${a.name}'s approval threshold` : `raise ${a.name}'s approval threshold to $${t}`, env);
  updateAccount(a.name, { approveAboveUsd: t });
  say(env, await s.update((b) => void (OwnerSession.entry(b, a.name).approveAboveUsd = t)));
  s.close();
  logOne(a.name, 'approve-above', `${msg} (owner PIN)`);
  return msg;
}

/** `bwalletx stop` / MCP `stop_all`: anyone, no PIN. Breaks the owner signature too (store.setAllStopped). */
export function stopAllAgents(by = 'stop') {
  setAllStopped(true, by);
  logAll('stop', `All agents stopped (${by})`);
}

/** MCP `lower_cap`: lowering only. */
export function lowerCap(name: string, usd: number): string {
  const a = resolveAccount(name);
  if (!(usd > 0)) throw new Error('Cap must be a positive number of USD');
  const eff = effectiveAccount(a);
  if (eff.dailyCapUsd !== null && usd > eff.dailyCapUsd) throw new OwnerRefused(`Refused: $${usd} is above the current $${eff.dailyCapUsd}/day cap. MCP can only lower caps; raising one is an owner step in a terminal.`);
  updateAccount(a.name, { dailyCapUsd: usd });
  logOne(a.name, 'cap', `Daily cap lowered to $${usd} (MCP)`);
  return `${a.name}: daily cap $${usd}`;
}

/** `bwalletx resume`: owner PIN / Touch ID. Re-signs with stopAll false, then removes the STOP file. */
export async function resumeAll(env: OwnerEnv = defaultOwnerEnv()): Promise<string> {
  const s = await requireOwner('resume all agents', env);
  if (s.kind === 'hardware') {
    // A stop drops the signature. A PIN owner's values are proved by re-signing; a Touch ID owner looks and decides.
    const st = readOwnerState();
    const body = st.state === 'tampered' ? stoppedBody(st.settings, s.publicKey) : null;
    if (body) {
      env.say('Limits from before the stop (a stop removes the signature, so check nothing was raised since):');
      for (const [n, a] of Object.entries(body.accounts)) env.say(`  ${n}: ${describe(a, a.liveStrategy ? 'approved' : null)}`);
      s.acceptStopped = await env.confirm('Resume with these limits? (No = safe defaults: $10/day cap, 30/hour, strategies on paper)');
    }
  }
  const source = await s.update((b) => {
    b.stopAll = false;
  });
  s.close();
  setAllStopped(false);
  say(env, source);
  logAll('resume', 'All agents resumed (owner PIN)');
  return 'Resumed.';
}

/** After `strategy load --live` wrote the file: sign exactly that file for that account. */
export async function approveLiveStrategy(s: OwnerSession, name: string, env: OwnerEnv = defaultOwnerEnv()) {
  const l = getLoaded(name);
  if (!l || l.mode !== 'live') throw new Error(`No live strategy loaded for ${name}`);
  say(env, await s.update((b) => void (OwnerSession.entry(b, name).liveStrategy = hashLoaded(l))));
}

/** After key import / login / pair: make sure the account has a signed entry (its config values, which are new-account defaults). */
export async function approveNewAccount(s: OwnerSession, name: string, env: OwnerEnv = defaultOwnerEnv()) {
  const a = readConfig().accounts[name];
  if (!a) return;
  say(env, await s.update((b) => void (b.accounts[name] ??= { ...accountFromConfig(a), liveStrategy: null })));
}

/** `bwalletx owner sign`: review config.json and sign it as the new ceiling. Keeps a stop in place. */
export async function ownerSign(env: OwnerEnv = defaultOwnerEnv()): Promise<string> {
  const s = await requireOwner('approve the settings in config.json', env);
  const { approved, accounts } = await reviewConfig(env, 'Sign these settings as the owner?');
  if (!approved) return (s.close(), 'Nothing signed.');
  await s.update((b) => {
    b.accounts = accounts;
    b.stopAll = b.stopAll || stopFileExists();
  });
  s.close();
  logAll('owner-sign', 'Settings in config.json signed by the owner');
  return 'Signed.' + (allStopped() ? ' Agents are still stopped: `bwalletx resume` turns them back on.' : '');
}

/** `bwalletx owner change`: old PIN, then a new one. The signed settings carry over. */
export async function ownerChange(env: OwnerEnv = defaultOwnerEnv()): Promise<string> {
  const hw = hardwareStore();
  if ((hw && readAnchorOrRefuse(hw)) || readHwOwnerFile()) throw new OwnerRefused('This owner uses Touch ID or your Mac password; there is no PIN to change.');
  const owner = readOwnerFile();
  if (!owner) throw new OwnerRefused('No owner PIN is set. Run `bwalletx owner setup`.');
  const s = await requireOwner('change the owner PIN', env);
  const { body, source } = s.base();
  const pin = await newPin(env);
  const { file, priv } = createOwner(pin, env.scrypt);
  writeOwnerFile(file);
  writeSettings({ ...body, publicKey: file.publicKey, seq: body.seq + 1, signedAt: Date.now() }, priv);
  say(env, source);
  logAll('owner-change', 'Owner PIN changed');
  return 'Owner PIN changed.';
}

/**
 * `bwalletx owner reset` (Mac): remove the Touch ID owner key from the Keychain, after Touch ID. Then everything runs
 * at the safe defaults until `owner setup` (Touch ID again). A shell can delete the Keychain item itself too, but
 * that only leaves the owner files pointing at a missing key: everything stays stopped, and setup needs Touch ID.
 */
export async function ownerReset(env: OwnerEnv = defaultOwnerEnv()): Promise<string> {
  assertHuman('reset the owner', env);
  const hw = hardwareStore();
  const anchor = hw ? readAnchorOrRefuse(hw) : null;
  if (!hw || !anchor) throw new OwnerRefused('There is no Touch ID owner key on this machine, so there is nothing to reset.');
  const ok = await env.confirm('Remove the Touch ID owner key? Every account then runs at the safe defaults ($10/day, 30/hour, strategies on paper) until you run `bwalletx owner setup` again.');
  if (!ok) return 'Nothing changed.';
  const signer = await presenceSigner(hw, anchor, 'reset the bwalletx owner (removes the Touch ID owner key)', env);
  signer.close?.();
  hw.removeAnchor();
  rmSync(ownerPath(), { force: true });
  rmSync(settingsPath(), { force: true });
  logAll('owner-reset', 'Touch ID owner key removed (Touch ID)');
  return 'Owner reset. Every account runs at the safe defaults until you run `bwalletx owner setup`.';
}

/** `bwalletx owner upgrade` (Mac): move a 0.6.0 PIN owner to a Touch ID key, keeping the signed settings. */
export async function ownerUpgrade(env: OwnerEnv = defaultOwnerEnv()): Promise<string> {
  assertHuman('move the owner to Touch ID', env);
  const hw = hardwareStore();
  if (!hw) throw new OwnerRefused('This machine has no hardware key store (Touch ID / Secure Enclave), so the owner stays a PIN.');
  if (readAnchorOrRefuse(hw)) throw new OwnerRefused('The owner already uses Touch ID.');
  if (!readOwnerFile()) throw new OwnerRefused('No owner PIN is set. Run `bwalletx owner setup` (on this Mac it uses Touch ID).');
  env.say(`Moving the owner to ${hw.prompt}. bwalletx first builds a small helper with Apple's swiftc (a few seconds).`);
  const avail = await hw.available();
  if (!avail.ok) throw new OwnerRefused(`This Mac can't make a Touch ID owner key (${avail.why}). The PIN stays.`);
  const pinSession = await requireOwner('move the owner to Touch ID', env);
  const { body, source } = pinSession.base();
  const anchor = await hw.generate();
  const signer = await presenceSigner(hw, anchor, 'move the bwalletx owner to Touch ID', env);
  try {
    hw.saveAnchor(anchor);
    writeOwnerFile(hwOwnerFile(anchor, hw.kind));
    await writeSignedSettings({ ...body, publicKey: anchor.publicKey, seq: body.seq + 1, signedAt: Date.now() }, signer);
  } finally {
    signer.close?.();
  }
  say(env, source);
  logAll('owner-upgrade', `Owner moved from PIN to ${hw.prompt}`);
  return `The owner now uses ${hw.prompt}. The old PIN no longer does anything.`;
}

/** `bwalletx owner status`: never needs the PIN or Touch ID, never prints secrets. */
export function ownerStatus() {
  const st = readOwnerState();
  const cfg = readConfig();
  const hw = hardwareStore();
  const stopAll = stopFileExists() || st.state === 'tampered' || (st.state === 'ok' && st.settings.stopAll);
  const gate = st.state === 'unset' ? (hw ? 'hardware' : 'software') : st.gate;
  const software = gate === 'software';
  return {
    pin: st.state === 'unset' ? 'not set' : gate === 'hardware' ? 'none (Touch ID owner)' : st.state === 'ok' ? 'set' : 'set, but the files could not be verified',
    state: st.state,
    /** 'hardware': loosening needs Touch ID / the Mac password; 'software': a PIN at a terminal. */
    gate,
    owner: st.state === 'unset' ? 'not set up' : gate === 'hardware' ? `${hw?.prompt ?? 'a hardware key'} (${hw?.label ?? 'not on this machine'})` : 'owner PIN',
    ...(software && { warning: SOFTWARE_ONLY_WARNING + (hw && st.state !== 'unset' ? ' This Mac can do better: run `bwalletx owner upgrade` to move the owner to Touch ID.' : '') }),
    ...(st.state === 'tampered' && { why: st.why }),
    stopped: stopAll,
    accounts: Object.values(cfg.accounts).map((a) => {
      const l = getLoaded(a.name);
      const e = effectiveAccount(a, st);
      return {
        name: a.name,
        effective: e,
        config: { dailyCapUsd: a.dailyCapUsd, ratePerHour: a.ratePerHour ?? null, approveAboveUsd: a.approveAboveUsd ?? null, stopped: a.stopped },
        strategy: l ? { name: l.strategy.name, mode: l.mode, ...(l.mode === 'live' && { approved: st.state === 'ok' && st.settings.accounts[a.name]?.liveStrategy === hashLoaded(l) }) } : null,
      };
    }),
  };
}
