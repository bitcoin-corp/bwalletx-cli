/**
 * Baked-in defaults for the bNamesX PC miner (owner approval, 24 Oct 2026). Addresses only: public, safe in git.
 * No key, WIF or passphrase ever goes in this file.
 */

/** Owner's vault ordinals address: where mined names are locked (same `--to` as the Mac mini run). */
export const VAULT_TO = '1HBfw7gShCV1Gw6vSrcnY9FK35P7uG7X3Z';
/** Owner's proceeds address (same `--to-pay` as the Mac mini run). */
export const VAULT_PAY = '1F4J9KkMoqtznXPJuCgb98LRymssc8MFfd';

/** Hard cap for this machine: 1 BSV in total, spent and funded. */
export const CAP_SATS = 100_000_000;

/** This machine's own hot agent account (plan: PC = opns4). Never the Mac mini's `opns`. */
export const ACCOUNT = 'opns4';

/**
 * The PC's slice: every all-digit name of 1 to 4 characters (0 … 9999, with leading-zero forms such as 007).
 * 11,110 names, which is also every node of that subtree, so each mined character is reused.
 * The Mac mini's queue (24 Oct) has no pending name that starts with a digit, so no prefix node is shared.
 */
export const RANGE_LABEL = 'digits only: 0–9, 00–99, 000–999, 0000–9999 (first character 0–9)';
export const MAX_DIGITS = 4;

export const digitNames = (max = MAX_DIGITS): string[] => {
  const out: string[] = [];
  for (let len = 1; len <= max; len++) for (let i = 0; i < 10 ** len; i++) out.push(String(i).padStart(len, '0'));
  return out;
};

/**
 * Default top-up from the extension, in dollars. At ~$17/BSV the whole digit list (11,110 characters × ~1,881
 * sats ≈ 0.21 BSV) costs about $4, so $5 covers it; the cap (1 BSV) is about $17.
 */
export const DEFAULT_FUND_USD = 5;
