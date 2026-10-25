// Types for github.mjs (plain JS, like lib.mjs). Keep in step with it.
import type { ScraperConfig, AccountInfo, HealthEntry } from './lib.mjs';

export const TOKEN_SECRET: 'ROSHEMET_TOKEN';
export const APP_VARIABLE: 'ROSHEMET_APP';
export const MAP_VARIABLE: 'ROSHEMET_MAP';
export const LOGIN_PREFIX: 'LOGIN_';
export function loginSecretName(company: string): string;
export function requiredFields(loginFields: string[] | undefined): string[];

export interface GithubGiven { app: string; map: string; token: string; logins: Record<string, string>; names: string[] }
export function githubEnv(env: Record<string, string | undefined>): GithubGiven;
export function commandData(s: unknown): string;
export function maskLines(given: Pick<GithubGiven, 'token' | 'logins'>): string[];
export function readGithubSettings(
  given: GithubGiven,
  companies: Record<string, { loginFields?: string[] }>,
): { config: ScraperConfig; problems: string[] };
export function runDays(raw: unknown, dflt?: number): number | null;
export function repoVisibility(r?: { api?: { private?: unknown } | null; event?: { repository?: { private?: unknown } } | null }): 'private' | 'public' | null;
export const PUBLIC_REPO: string;
export function unmappedGithubLine(u: AccountInfo): string;
export function trimLog(text: unknown, keep?: number): string;
export function runSummary(r: { entries?: (HealthEntry & { said?: string })[]; notes?: string[]; outcome: string }): string;
export function checkSummary(checks: { ok: boolean; line: string }[]): string;
