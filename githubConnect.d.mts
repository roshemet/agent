// Types for githubConnect.mjs (plain JS, like lib.mjs). Keep in step with it.
import type { ScraperConfig } from './lib.mjs';

export const WORKFLOW: 'agent.yml';
export function cleanRepo(raw: unknown): string | null;
export function tokenLink(repo: string): string;
export function tokenSteps(repo: string): string;
export function explainGithub(step: string, status: number, repo: string, body?: { message?: string }): string;
export class GithubRefused extends Error {}
export function secretsPlan(config: Pick<ScraperConfig, 'logins'>, companies: Record<string, unknown>): {
  writes: { company: string; name: string; value: string }[];
  unknown: string[];
};
export function extraLoginSecrets(existing: string[], writes: { name: string }[]): string[];
export function logLines(text: unknown, max?: number): string[];

export type GithubCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any; text?: string }>;
export interface GithubRun { id: number; status: string; conclusion: string | null; html_url: string }
export function connectRepo(d: {
  repo: string;
  config: Pick<ScraperConfig, 'endpoint' | 'logins' | 'map'>;
  companies: Record<string, unknown>;
  gh: GithubCall;
  seal: (publicKeyB64: string, value: string) => string;
  pair: () => Promise<string>;
  newPairing?: boolean;
  log: (line: string) => void;
  days?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waits?: { start: number; check: number; run: number };
}): Promise<{ check: GithubRun; first: GithubRun | null }>;
