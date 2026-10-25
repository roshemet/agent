// Types for lib.mjs (the repo's tsconfig has no node typings, so the script
// itself is plain JS). Keep in step with lib.mjs.

export type Slot = 'bank' | 'card1' | 'card2' | 'card3' | 'card4';
export const SLOTS: Slot[];

export interface ScraperConfig {
  endpoint: string;
  token: string;
  /** companyId -> the login fields israeli-bank-scrapers asks for. */
  logins: Record<string, Record<string, string>>;
  /** "company:last4" -> slot, or 'skip' for an account not to import. */
  map: Record<string, Slot | 'skip'>;
}
export interface VaultKdf { N: number; r: number; p: number }

export const KEY_STORES: readonly ('dpapi' | 'keychain')[];
export function encryptVault(config: ScraperConfig, passphrase: string, kdf?: VaultKdf, meta?: { key?: string | null }): string;
export function vaultMeta(text: string): { key: 'dpapi' | 'keychain' | null };
export function decryptVault(text: string, passphrase: string): ScraperConfig;
export function emptyConfig(): ScraperConfig;
export function cleanEndpoint(raw: unknown): string | null;

export function last4(accountNumber: unknown): string;
export function mapKey(company: string, digits: string): string;
export function setMapping(config: ScraperConfig, company: string, digits: string, slot: string): ScraperConfig;

export interface ScrapedAccountIn {
  accountNumber: string;
  /** The account's balance as the site showed it (banks; a card company's means something else). */
  balance?: number;
  txns: {
    date: string; processedDate?: string; chargedAmount: number; description: string;
    status?: string; installments?: { number: number; total: number } | null; category?: string;
    identifier?: string | number; memo?: string;
  }[];
}
export interface AccountInfo { company: string; last4: string; txns: number }
export function buildPayload(
  config: ScraperConfig,
  results: { company: string; at?: string; accounts: ScrapedAccountIn[] }[],
  dryRun: boolean,
): {
  payload: { dryRun: boolean; accounts: { slot: Slot; txns: Record<string, unknown>[]; balance?: number; balanceAt?: string }[] };
  unmapped: AccountInfo[];
  skipped: AccountInfo[];
};
export function commandFor(args: string, onBox: boolean): string;
/** `other` is read from a file: anything malformed in it is skipped. */
export function importLogins(config: ScraperConfig, other: { logins?: Record<string, unknown>; map?: Record<string, unknown> }): { logins: string[]; replaced: string[]; mapped: string[] };
export function unmappedLine(u: AccountInfo, onBox: boolean): string;

export function adviceFor(errorType: string | undefined): string;
export interface HealthEntry { at: string; company: string; ok: boolean; errorType?: string; txns?: number; newest?: string; browser?: string }
export function healthWarnings(log: HealthEntry[], today: string): string[];

export const PS_PROTECT: string;
export const PS_UNPROTECT: string;
export type PsRunner = (script: string, input: string) => Promise<string>;
export function powershell(script: string, input: string): Promise<string>;
export function protectKey(passphrase: string, run?: PsRunner): Promise<string>;
export function unprotectKey(blob: string, run?: PsRunner): Promise<string>;

export const TASK_NAME: string;
export function checkSchedule(day: string, time: string): { day: string; time: string };
export function autoCmd(p: { nodePath: string; scriptPath: string; vaultPath: string; logPath: string }): string;
export function schtasksCreateArgs(cmdPath: string, day: string, time: string): string[];
export function failureWarnings(failures: { company: string; errorType: string }[]): string[];

export function errorChain(err: unknown): { code: string; message: string }[];
export function describeFetchError(err: unknown, url: string): string;
export function rowsCsv(slots: {
  slot: string;
  newRows?: { date: string; description: string; amount: number; type: string }[];
  excludedRows?: { date: string; description: string; amount: number; kind: string }[];
}[], map?: Record<string, string>): string;
export function slotLabel(slot: string, map?: Record<string, string>): string;

export function readSealedKey(text: unknown): string;
export function normalizePairCode(raw: unknown): string | null;
export function pairRefusal(status: number, body?: { error?: string; detail?: string }): string;
export const LINUX_INSTEAD: Readonly<Record<'remember' | 'forget' | 'schedule' | 'automate' | 'listen' | 'unschedule' | 'setup' | 'uninstall', string>>;
export function cleanSecretInput(s: unknown): string;
export function tokenProblem(token: unknown): string | null;
export function cleanConfigSecrets(config: ScraperConfig): boolean;

export function generateToken(): string;
export function refusalMessage(status: number, body?: { error?: string; detail?: string }): string;
export function interpretCheck(status: number, body?: { error?: string; detail?: string }): { ok: boolean; message: string };

export function looksReversed(s: unknown): boolean;
export function fixVisualOrder(desc: unknown): string;
export function classifyFailure(errorType: unknown, errorMessage: unknown): string;

export function recentBlock(log: HealthEntry[], company: string, now?: Date, hours?: number): HealthEntry | null;
export const POLL_TASK_NAME: string;
export function isShabbatWindow(now?: Date): boolean;
export const YOM_TOV: Readonly<Record<string, number[]>>;
export const EREV_HOUR: number;
export function addDays(ymd: string, n: number): string;
export function hebrewDate(ymd: string): { day: number; month: string };
export function isYomTov(ymd: string): boolean;
export type QuietKind = 'shabbat' | 'yomtov';
export function quietDay(ymd: string): QuietKind | null;
export function israelClock(now?: Date): { ymd: string; hour: number };
export function israelMidnight(ymd: string): Date;
export interface QuietWindow { kind: QuietKind; until: Date }
export function quietWindow(now?: Date): QuietWindow | null;
export function describeQuiet(q: QuietWindow): string;
export function autoRunQuietSkip(now?: Date): string | null;
export function pollCmd(p: { nodePath: string; scriptPath: string; vaultPath: string; logPath: string }): string;
export function hiddenLauncherVbs(cmdPath: string): string;
export function schtasksPollArgs(vbsPath: string, minutes?: number, name?: string): string[];

export const LISTEN_LOCK_STALE_MS: number;
export const STARTUP_LAUNCHER: string;
export function startupFolder(appData: string | undefined): string;
export function listenerAlive(
  lock: { pid?: number; at?: string } | null | undefined,
  o: { now?: Date; ownPid: number; pidAlive: (pid: number) => boolean },
): boolean;
export interface LockFs {
  writeFileSync(path: string, data: string, o?: { flag?: string }): void;
  readFileSync(path: string, enc: 'utf8'): string;
  statSync(path: string): { mtimeMs: number };
  unlinkSync(path: string): void;
}
export function takeLock(path: string, o: { fs: LockFs; pid: number; now?: () => Date; pidAlive: (pid: number) => boolean }): boolean;
export function refreshLock(path: string, o: { fs: LockFs; pid: number; now?: () => Date }): boolean;
export function releaseLock(path: string, o: { fs: LockFs; pid: number }): void;
export function nextBackoff(prevMs: number): number;
export class Refused extends Error {}
export function listenLoop<S extends string>(o: {
  ask: () => Promise<{ requested?: boolean; at?: string } | null | undefined>;
  scrape: () => Promise<unknown>;
  shouldStop: () => S | null | undefined | false;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  onConnected?: () => void;
  now?: () => Date;
  quiet?: (now: Date) => QuietWindow | null;
}): Promise<S>;
export const QUIET_NAP_MS: number;
