// Types for computer.mjs (plain JS, like lib.mjs). Keep in step with it.
export interface AgentNames {
  name: string; dailyTask: string; listenTask: string; startupLauncher: string;
  dailyLabel: string; listenLabel: string; keychainService: string; dailyAt: string;
}
export const AGENT: Readonly<AgentNames>;
export interface RunResult { status: number; stdout: string; stderr: string }
export type Runner = (program: string, args: string[], o: { input?: string }) => RunResult;
export function keychainAccount(vaultPath: string): string;
export function keychainAddInput(secret: string, vaultPath: string, o?: AgentNames): string;
export function keychainFindArgs(vaultPath: string, o?: AgentNames): string[];
export function keychainDeleteArgs(vaultPath: string, o?: AgentNames): string[];
export function explainKeychain(r: Partial<RunResult> | undefined): string;
export function keychainLoad(vaultPath: string, run: Runner, o?: AgentNames): string;
export function keychainSave(secret: string, vaultPath: string, run: Runner, o?: AgentNames): void;
export function keychainRemove(vaultPath: string, run: Runner, o?: AgentNames): boolean;
export interface PlistFiles { node: string; script: string; vault: string; logPath: string }
export function dailyPlist(files: PlistFiles, at?: string, o?: AgentNames): string;
export function listenPlist(files: PlistFiles, o?: AgentNames): string;
export const launchctlArgs: Readonly<{
  bootstrap(uid: number, plistPath: string): string[];
  bootout(uid: number, label: string): string[];
  print(uid: number, label: string): string[];
}>;
export function launchdState(printOut: string): string | null;
export function dailyCmd(o: { nodePath: string; scriptPath: string; vaultPath: string; logPath: string }): string;
export function schtasksDailyArgs(vbsPath: string, at?: string, o?: AgentNames): string[];
export function schtasksQueryArgs(name: string): string[];
export function schtasksState(csvOut: string): { next: string | null; status: string | null };
