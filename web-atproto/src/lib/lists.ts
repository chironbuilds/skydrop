/** Campaigns' allocation lists, kept on Skydrop so share links stay short. Whatever comes back is checked against the
 * root the contract holds, so the storage can lose a list but can't change one. */
import { SKYDROP } from "../data/deployment";
import { allocationRoot, type Allocation } from "./campaign";

/** Stores a list and returns its root. It says so if the root isn't the one this browser worked out. */
export async function saveList(list: Allocation[]): Promise<string> {
  const r = await fetch(`${SKYDROP}/api/list`, { method: "POST", body: JSON.stringify(list), signal: AbortSignal.timeout(20_000) });
  const j = (await r.json().catch(() => null)) as { root?: string; error?: string } | null;
  if (!r.ok || !j?.root) throw new Error(j?.error ?? `The list couldn't be saved (${r.status}).`);
  if (j.root !== (await allocationRoot(list))) throw new Error("The list was saved under the wrong fingerprint.");
  return j.root;
}

/** The list with this root, or null if there isn't one. A list that doesn't match its root is treated as missing. */
export async function fetchList(root: string): Promise<Allocation[] | null> {
  try {
    const r = await fetch(`${SKYDROP}/api/list/${root}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const list = (await r.json()) as Allocation[];
    return Array.isArray(list) && list.length && (await allocationRoot(list)) === root ? list : null;
  } catch {
    return null;
  }
}

/** Whether a list really is the one with this root. Malformed lists aren't. */
export async function listMatches(list: Allocation[] | undefined, root: string): Promise<boolean> {
  if (!list?.length) return false;
  try {
    return (await allocationRoot(list)) === root;
  } catch {
    return false;
  }
}
