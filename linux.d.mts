// Types for linux.mjs (plain JS, like lib.mjs). Keep in step with it.
export interface BoxPaths {
  user: string; repoDir: string; scrapeDir: string; stateDir: string; vault: string;
  credName: string; credFile: string; node: string; npm: string; chromium: string; wrapper: string;
  unitDir: string; listenUnit: string; dailyUnit: string; dailyTimer: string; dailyAt: string;
  sysctlFile: string; deployKey: string; endpoint: string; filterUnit: string;
}
export const BOX: Readonly<BoxPaths>;
export type FilterMode = 'off' | 'watch' | 'enforce';
export function serviceProperties(box?: BoxPaths, o?: { filtered?: boolean }): [string, string][];
export function filterDeps(mode: FilterMode, box?: BoxPaths): string;
export function listenUnit(box?: BoxPaths, mode?: FilterMode): string;
export function dailyUnit(box?: BoxPaths, mode?: FilterMode): string;
export function dailyTimer(box?: BoxPaths): string;
export function wrapperScript(box?: BoxPaths): string;
export function runArgs(args: string[], o: { tty: boolean; filtered?: boolean }, box?: BoxPaths): string[];
export function sealArgs(credFile?: string, box?: BoxPaths): string[];
export function unsealCheckArgs(credFile?: string, box?: BoxPaths): string[];
export function explainCredError(text: unknown): string;
export interface RunResult { status: number; stdout: string; stderr: string }
export function sealAndVerify(
  key: string,
  o: { run: (program: string, args: string[], o: { input?: string }) => RunResult; removeFile: (path: string) => void; credFile?: string },
  box?: BoxPaths,
): void;
export const TPM_LIBS: string[];
export function missingTpmLibs(ldconfigP: unknown): string[];
export function nodeTooOld(version: string, min?: string): boolean;
export const SYSCTL_CONF: string;
export function setIni(text: unknown, section: string, values: Record<string, string>): string;
export function hardenGuestAgent(instanceConfigsText: unknown): string;
export function swapWarning(procSwaps: unknown): string | null;
