/**
 * Hardware-backed owner key (0.7.0). The interface the owner gate talks to; the macOS implementation is in
 * macOwnerStore.ts and tests use an in-memory one.
 *
 * Why: in 0.6.0 the owner key came from a PIN typed at a terminal. An agent with a shell can fake a terminal
 * (`script`) and unset CLAUDECODE, so before a PIN exists it can set its own, and after that it can delete the
 * owner files and set one again. A hardware store keeps the owner key where a shell can't use it:
 *
 *   - the private key is made inside the Secure Enclave with an access control that needs user presence
 *     (Touch ID, or the Mac login password) for EVERY signature. A shell can read the key's wrapped blob but
 *     can't sign with it: the Enclave itself refuses without the prompt being answered;
 *   - an ANCHOR in the macOS Keychain records which key is the owner. The gate checks the signed settings
 *     against the anchor's public key, not against anything in ~/.bwalletx alone;
 *   - while an anchor exists, setup is refused. Deleting ~/.bwalletx/owner*.json only leaves everything stopped;
 *   - with no anchor, setup on a Mac always makes a new Enclave key and needs the prompt to finish, so an agent
 *     that deletes everything (Keychain item included) gets the safe defaults, never its own owner.
 */
import { macOwnerStore } from './macOwnerStore.js';

/** Which key is the owner. Never secret: the blob is useless off this Mac's Secure Enclave and without presence. */
export type HwAnchor = {
  /** Uncompressed P-256 public key (04 || x || y), hex, 130 chars. */
  publicKey: string;
  /** The Secure Enclave's wrapped key (CryptoKit dataRepresentation), base64. Only this Mac's Enclave can use it. */
  blob: string;
  createdAt: number;
};

/** A user-presence session: opened with ONE prompt, then signs messages until closed. */
export interface HwSigner {
  /** P-256 ECDSA over SHA-256(msg); raw r||s, 64 bytes. */
  sign(msg: Buffer): Promise<Buffer>;
  close(): void;
}

/**
 * noHardware: true only for a definite "this machine has no Secure Enclave" from the helper. Other failures (no
 * swiftc, a failed build) don't set it, because an agent could cause them, and setup must not then fall back to a PIN.
 */
export type HwAvailability = { ok: true } | { ok: false; why: string; noHardware?: boolean };

export interface HardwareOwnerStore {
  /** e.g. 'macos-secure-enclave'. Written to owner.json. */
  readonly kind: string;
  /** For people: 'Touch ID or your Mac password'. */
  readonly prompt: string;
  /** For people: where the key lives. */
  readonly label: string;
  /** Can a new hardware owner key be made here? May be slow (compiles the helper). Only called by setup/upgrade. */
  available(): Promise<HwAvailability>;
  /**
   * The anchor, or null when there is none. No prompt, fast enough to call on every spend. THROWS when the store
   * can't be read, and the caller then treats the owner state as unverifiable (stopped): fail closed.
   */
  readAnchor(): HwAnchor | null;
  /** A new user-presence key. Nothing is saved; no prompt. */
  generate(): Promise<HwAnchor>;
  /** Save the anchor. Throws if one already exists. */
  saveAnchor(a: HwAnchor): void;
  /** Delete the anchor. Callers prove presence first (a shell can also do this, which only stops everything). */
  removeAnchor(): void;
  /** One presence prompt showing `reason`; throws when the owner cancels or it fails. */
  open(a: HwAnchor, reason: string): Promise<HwSigner>;
}

let override: HardwareOwnerStore | null | undefined;

/**
 * For tests only: replace the platform store (null = none, as on Linux; undefined = back to the platform default).
 * There is deliberately no environment variable or flag for this: anything an agent could set would turn it off.
 */
export const setHardwareStore = (s: HardwareOwnerStore | null | undefined) => {
  override = s;
};

let platformStore: HardwareOwnerStore | null | undefined;

/** The hardware store for this machine, or null when there is none (Linux, Windows, CI). */
export function hardwareStore(): HardwareOwnerStore | null {
  if (override !== undefined) return override;
  if (platformStore === undefined) platformStore = process.platform === 'darwin' ? macOwnerStore() : null;
  return platformStore;
}
