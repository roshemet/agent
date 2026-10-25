// Types for diagnostics.mjs (plain JS, like lib.mjs). Keep in step with it.
import type { HealthEntry } from './lib.mjs';
export function scrubPersonal(text: unknown, secrets?: unknown[], max?: number): string;
export interface RunResultIn {
  success?: boolean; errorType?: string; errorMessage?: string;
  accounts?: { accountNumber?: string; txns?: { date?: string; description?: string; chargedAmount?: number }[] }[];
}
export function runLogEntry(
  meta: { at: string; company: string; browser?: string },
  r: RunResultIn,
  creds?: Record<string, string>,
  classify?: (type: string | undefined, message: string | undefined) => string,
): HealthEntry & { said?: string };
export interface DiagnosticsInput {
  now: Date;
  versions: { agent?: string; library?: string | null; patches?: string[]; node?: string; os?: string; browser?: string | null };
  home: 'windows' | 'mac' | 'linux' | 'box' | 'github' | string;
  vault: { exists: boolean; keyStore?: string | null };
  state?: { pairedAt?: string | null };
  schedule?: string[];
  listener?: { alive: boolean; connectedAt?: string | null; at?: string | null } | null;
  quiet?: string | null;
  log?: (HealthEntry & { said?: string })[];
  warnings?: string[];
  perCompany?: number;
}
export function diagnosticsReport(d: DiagnosticsInput): string;
