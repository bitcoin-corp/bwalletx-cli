/**
 * The one gate every spending action passes, from the CLI, `agent run` and MCP alike:
 *   kill switch / account stopped → daily cap → rate limit (default, or the account's own) → loaded strategy's rules → (paper) fill.
 * Same order and rules as the app's checkAgentAction. Refusals are logged with the rule that refused.
 * In paper mode an allowed action is filled on the paper book and logged, and the caller must NOT sign.
 */
import {
  checkRules,
  dayStart,
  paperFill,
  spendAllowed,
  spentSince,
  type ActionRequest,
  type AgentLogEntry,
  type Loaded,
  type PaperBook,
  type RuleState,
} from './strategy.js';
import { randomUUID } from 'node:crypto';
import {
  addReservation,
  allStopped,
  appendLog,
  getLoaded,
  getPaper,
  readLog,
  readReservations,
  removeReservation,
  reservationLive,
  resolveAccount,
  setPaper,
  withSpendLock,
  type AccountConfig,
} from './store.js';
import { RATE_LIMIT_PER_HOUR } from './limits.js';
import { effectiveAccount, liveApproved, readOwnerState } from './owner.js';

export { RATE_LIMIT_PER_HOUR };
const HOUR = 3_600_000;

/** Log actions that count toward the rate limit (attempted or done spends, live or paper). */
export const isSpendEntry = (e: AgentLogEntry) => /^(send|buy|sell|list|failed|paper-|reserved|opns-(send|sweep|unlist)$)/.test(e.action);

export const rateLimited = (log: AgentLogEntry[], now: number, limit = RATE_LIMIT_PER_HOUR) =>
  log.filter((e) => e.at > now - HOUR && e.at <= now && isSpendEntry(e)).length >= limit;

export type GateInput = {
  account: AccountConfig | null;
  stopAll: boolean;
  log: AgentLogEntry[];
  loaded: Loaded | null;
  book: PaperBook;
  action: ActionRequest;
  extra?: Omit<RuleState, 'spentTodayUsd' | 'spentTotalUsd'>;
  now: number;
  /** false when a live strategy is loaded that the owner has not signed (owner.ts). Default true (pure tests). */
  liveApproved?: boolean;
};
export type GateResult =
  | { ok: true; paper: boolean; book?: PaperBook; logEntry?: AgentLogEntry }
  | { ok: false; reason: string; rule?: string; logEntry: AgentLogEntry };

/** Pure decision. `book` (paper) and `logEntry` are what the caller persists. */
export const evaluateGate = ({ account, stopAll, log, loaded, book, action: a, extra = {}, now, liveApproved: liveOk = true }: GateInput): GateResult => {
  const refuse = (reason: string, rule?: string): GateResult => ({
    ok: false,
    reason,
    rule,
    logEntry: { at: now, action: 'refused', detail: `Refused ${a.kind} ${a.token}: ${reason}`, usd: 0, ...(rule && { rule }) },
  });
  const paper = loaded?.mode === 'paper';
  const acct = spendAllowed(
    account ? { identityAddress: account.identityAddress, labels: [], stopped: account.stopped, dailyCapUsd: account.dailyCapUsd, createdAt: account.importedAt } : null,
    stopAll,
    log,
    paper ? 0 : a.usd,
    now,
  );
  if (!acct.ok) return refuse(acct.reason, acct.reason.startsWith('Over today') ? 'dailyCap' : 'stop');
  // A live strategy file the owner did not sign with the PIN (hand-edited, or loaded live before 0.6.0).
  if (!paper && loaded && !liveOk) return refuse('Live strategy not approved with the owner PIN (run `bwalletx strategy load <file> --live` in your own terminal)', 'owner');
  // Bigger spends wait for the owner (bAgents approvals). Paper fills never need it.
  const limit = account?.approveAboveUsd;
  if (!paper && limit != null && a.usd > limit) return refuse(`Needs owner approval: over $${limit} per action`, 'approval');
  // Per-account override: a number sets the limit, 0 turns it off for that account (owner-set), unset = default.
  const rate = account?.ratePerHour ?? RATE_LIMIT_PER_HOUR;
  if (rate > 0 && rateLimited(log, now, rate)) return refuse(`Rate limit: at most ${rate} spending actions per hour`, 'rateLimit');
  if (!loaded) return { ok: true, paper: false };

  const st: RuleState = paper
    ? {
        spentTodayUsd: 0, // paper spending is tracked on the book, not per day
        spentTotalUsd: book.spentUsd,
        holding: loaded.strategy.rules.tokens.reduce((s, t) => s + (book.tokens[t.replace(/^\$/, '').toUpperCase()] ?? 0), 0),
        ...extra,
      }
    : {
        spentTodayUsd: spentSince(log, Math.max(dayStart(now), loaded.loadedAt)),
        spentTotalUsd: spentSince(log, loaded.loadedAt),
        startValueUsd: loaded.startValueUsd,
        ...extra,
      };
  const r = checkRules(loaded.strategy.rules, a, st);
  if (!r.ok) return refuse(r.reason, r.rule);
  if (!paper) return { ok: true, paper: false };

  const f = paperFill(book, a);
  if (!f.ok) return refuse(f.reason, 'paper');
  const what = a.amount ? `${+a.amount.toFixed(6)} ${a.ticker ?? a.token}` : (a.ticker ?? a.token);
  return {
    ok: true,
    paper: true,
    book: f.book,
    logEntry: {
      at: now,
      action: `paper-${a.kind}`,
      detail: `Paper ${a.kind} ${what}${a.usd ? ` for $${a.usd.toFixed(2)}` : ''}${a.priceUsd ? ` @ $${a.priceUsd}` : ''}${a.to ? ` to ${a.to}` : ''}`,
      usd: 0,
      rule: loaded.strategy.name,
    },
  };
};

/**
 * Gate against stored state for an account; persists the log entry and paper book.
 * The account's limits are the EFFECTIVE ones: the tighter of the owner-signed ceiling and config.json, so a hand
 * edit to config.json can't loosen anything (owner.ts). Approve-above is part of that and is never skipped here:
 * there is no code path where the owner PIN approves a spend; the PIN only signs settings.
 */
export const gateAction = (name: string, action: ActionRequest, extra: GateInput['extra'] = {}, now = Date.now()) => {
  const st = readOwnerState();
  let account: AccountConfig | null = null;
  try {
    const a = resolveAccount(name);
    account = { ...a, ...effectiveAccount(a, st) };
  } catch {
    account = null;
  }
  const loaded = getLoaded(name);
  // Spends reserved by other processes (or other requests here) count as if already logged.
  const log = [...readLog(name), ...readReservations(name)];
  const res = evaluateGate({ account, stopAll: allStopped(), log, loaded, book: getPaper(name), action, extra, now, liveApproved: liveApproved(st, name, loaded) });
  if (res.ok && res.book) setPaper(name, res.book);
  if (res.logEntry) appendLog(name, res.logEntry);
  return res;
};

export type Reserved =
  | { ok: false; reason: string; rule?: string }
  | {
      ok: true;
      paper: boolean;
      /** Log the outcome (with the dollars actually at risk) and drop the reservation. */
      settle: (entry: AgentLogEntry) => void;
      /** Nothing left the account: drop the reservation, nothing is logged. */
      release: () => void;
    };

/**
 * Gate a spend and reserve its dollars in one step, under the account's spend lock, before anything is signed.
 * The reservation is a file other processes' gates count, so the lock is held only for the check, not while signing.
 * Exactly one of settle / release must follow. A reservation whose process died is turned into a counted
 * `failed` entry here (it may have been broadcast), so a crash never leaves a spend uncounted.
 */
export const reserveSpend = (name: string, action: ActionRequest, extra: GateInput['extra'] = {}, now = Date.now()): Promise<Reserved> =>
  withSpendLock(name, async () => {
    for (const r of readReservations(name))
      if (!reservationLive(r)) {
        appendLog(name, { at: r.at, action: 'failed', detail: `${r.detail}: interrupted before it was settled (counted against the cap)`, usd: r.usd });
        removeReservation(name, r.id);
      }
    const g = gateAction(name, action, extra, now);
    if (!g.ok) return { ok: false, reason: g.reason, ...(g.rule && { rule: g.rule }) };
    const noop = () => undefined;
    if (g.paper) return { ok: true, paper: true, settle: noop, release: noop };
    const id = randomUUID();
    addReservation(name, { id, pid: process.pid, at: now, action: 'reserved', detail: `Reserved ${action.kind} ${action.ticker ?? action.token}${action.to ? ` to ${action.to}` : ''}`, usd: action.usd > 0 ? action.usd : 0 });
    let done = false;
    return {
      ok: true,
      paper: false,
      settle: (entry) => {
        if (done) return;
        done = true;
        appendLog(name, entry);
        removeReservation(name, id);
      },
      release: () => {
        if (done) return;
        done = true;
        removeReservation(name, id);
      },
    };
  });

type WalletLike = object;

/**
 * Wrap a wallet to tell, after a builder answered with an error, whether anything may have gone out. It "may have
 * broadcast" once the wallet was asked to sign or process: `signAction`, `internalizeAction`, or a `createAction`
 * that signs and processes (the default) or returned a txid. The only `createAction` that can't have sent anything is
 * one made with `signAndProcess: false` that threw or handed back a signable transaction. Callers release a
 * reservation only when this says false; otherwise the spend stays counted (fail closed).
 */
export function watchBroadcast<W extends WalletLike>(w: W): { wallet: W; mayHaveBroadcast: () => boolean } {
  let may = false;
  const wallet = new Proxy(w, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r) as unknown;
      if (typeof v !== 'function') return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(t);
      if (p === 'signAction' || p === 'internalizeAction')
        return (...a: unknown[]) => {
          may = true;
          return fn(...a);
        };
      if (p === 'createAction')
        return async (args: { options?: { signAndProcess?: boolean } }, ...rest: unknown[]) => {
          const deferred = args?.options?.signAndProcess === false;
          if (!deferred) may = true;
          const res = (await fn(args, ...rest)) as { txid?: string; signableTransaction?: unknown } | undefined;
          if (res?.txid || !res?.signableTransaction) may = true;
          return res;
        };
      return fn;
    },
  });
  return { wallet: wallet as W, mayHaveBroadcast: () => may };
}
