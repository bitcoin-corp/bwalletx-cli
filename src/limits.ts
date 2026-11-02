/** Shared limits and paths with no imports of their own, so every module (including owner.ts) can use them. */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Daily cap (USD, per UTC day) a NEW account starts with (24 Oct 2026 audit): before this, new accounts
 * had no cap and an agent or MCP client could send the whole balance. It is also the most a day may move
 * while settings are not signed with the owner PIN (see owner.ts).
 */
export const DEFAULT_DAILY_CAP_USD = 10;

/** Default spending actions per hour; an account can set its own (`bwalletx ratelimit <account> <n|off>`). */
export const RATE_LIMIT_PER_HOUR = 30;

export const home = () => process.env.BWALLETX_HOME || join(homedir(), '.bwalletx');
