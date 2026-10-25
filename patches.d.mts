// Types for patches.mjs. Keep in step with it.
export interface LibPatch { id: string; company: string; version: string; file: string; why: string; original: string; patched: string }
export const PATCHES: LibPatch[];
export function applyPatch(text: string, patch: LibPatch, installedVersion: string): { status: 'applied' | 'already' | 'version' | 'mismatch'; text: string };
export function ensurePatched(libDir: string, o?: { writeFile?: (path: string, text: string) => void }): Promise<string[]>;
