/** Campaigns being designed, kept in this browser. Nothing here is public or on-chain until someone launches it. */
import type { Spec } from "./campaign";

export interface Draft { id: string; spec: Spec; updated: number; owner: string | null }

const KEY = "atp-drafts";

function read(): Draft[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Draft[];
    return Array.isArray(list) ? list.filter((d) => d && d.id && d.spec && Array.isArray(d.spec.rules)) : [];
  } catch {
    return [];
  }
}

function write(list: Draft[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export const allDrafts = (): Draft[] => read().sort((a, b) => b.updated - a.updated);
export const getDraft = (id: string): Draft | undefined => read().find((d) => d.id === id);
export const newDraftId = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Saves a draft. A draft keeps the first wallet it was saved under, so it isn't reassigned by switching accounts. */
export function saveDraft(id: string, spec: Spec, owner: string | null): boolean {
  const list = read();
  const at = list.findIndex((d) => d.id === id);
  const draft: Draft = { id, spec: JSON.parse(JSON.stringify(spec)) as Spec, updated: Date.now(), owner: at >= 0 ? list[at]!.owner ?? owner : owner };
  if (at >= 0) list[at] = draft;
  else list.push(draft);
  return write(list);
}

export function deleteDraft(id: string): void {
  write(read().filter((d) => d.id !== id));
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} days ago`;
}
