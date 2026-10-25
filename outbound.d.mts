// Types for outbound.mjs (plain JS, like lib.mjs). Keep in step with it.
import type { Server, Socket } from 'node:net';
import type { BoxPaths, FilterMode } from './linux.mjs';

export interface OutboundPaths {
  user: string; dir: string; stateFile: string; allowFile: string; nftFile: string; dnsmasqFile: string;
  table: string; dnsPort: number; sniPort: number; rulesUnit: string; dnsUnit: string; sniUnit: string;
  logOut: string; logBlocked: string; nft: string; dnsmasq: string;
}
export const OUTBOUND: Readonly<OutboundPaths>;
export const MODES: readonly FilterMode[];
export const BANK_DOMAINS: Readonly<Record<string, string[]>>;
export const SEEN_EXTRA: readonly string[];
export function normalizeHost(h: unknown): string | null;
export function hostAllowed(host: unknown, list: readonly string[]): boolean;
export function allowList(o?: { endpoint?: string; extra?: readonly string[] }): string[];
export function allowFileText(list: readonly string[]): string;
export function readAllowFile(text: unknown): string[];
export function aptBusy(output: unknown): boolean;
export function aptWithWaits(what: string, args: string[], o: {
  run: (args: string[]) => { status: number; stdout: string; stderr: string };
  sleep: (ms: number) => Promise<unknown>;
  log?: (line: string) => void;
  stepS?: number;
  maxS?: number;
}): Promise<void>;
export function nameservers(resolvConf: unknown): string[];
export function nftRules(mode: FilterMode, o?: { user?: string }, paths?: OutboundPaths): string;
export function dnsmasqConf(mode: FilterMode, o?: { list?: readonly string[]; upstream?: readonly string[] }, paths?: OutboundPaths): string;
export function dnsUnit(paths?: OutboundPaths): string;
export function sniUnit(box?: BoxPaths, paths?: OutboundPaths): string;
export function rulesUnit(mode: FilterMode, box?: BoxPaths, paths?: OutboundPaths): string;
export type Hello = { need: true } | { error: string } | { host: string | null; ech: boolean };
export function parseClientHello(buf: Uint8Array, maxBytes?: number): Hello;
export interface CheckServer extends Server { setList(list: string[]): void }
export function hostnameCheck(o: {
  list: string[];
  connect?: (host: string) => Socket;
  log?: (line: string) => void;
  helloTimeoutMs?: number;
  connectTimeoutMs?: number;
}): CheckServer;
export interface SelftestResult { what: string; pass: boolean; detail: string }
export function selftest(mode: FilterMode, o?: {
  app?: string; outsider?: string;
  resolve4?: (host: string) => Promise<string[]>;
  handshake?: (host: string, servername: string) => Promise<unknown>;
  tcpOpen?: (host: string, port: number) => Promise<unknown>;
}): Promise<SelftestResult[]>;
export function filterInPlace(resolve4?: (host: string) => Promise<string[]>, outsider?: string): Promise<boolean>;
export function filterGuard(o?: { stateText?: string; resolve4?: (host: string) => Promise<string[]> }): Promise<string | null>;
export function readState(text: unknown): { mode: FilterMode; since: string | null };
export interface Flow { dst: string; proto: string; port: number | null; out: number; blocked: number }
export interface Logs {
  asked: Map<string, number>; refusedNames: Map<string, number>; addressNames: Map<string, Set<string>>;
  flows: Map<string, Flow>; allowed: Map<string, number>; refused: Map<string, number>;
}
export function readLogs(o?: { dns?: string; kernel?: string; sni?: string }): Logs;
export function formatReport(logs: Logs, o: { list: readonly string[]; mode: FilterMode; since: string | null }): string;
