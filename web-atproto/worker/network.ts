/**
 * Moves a Worker on a main domain from the testnet to mainnet by itself. It waits for the launch time and for the mainnet
 * indexer to answer as mainnet, so a late launch leaves the sites on the testnet rather than pointing at nothing.
 */
import { BUILD_NETWORK, DEPLOYMENT, MAINNET_LAUNCH_MS, mainnetPublished, useMainnet } from "../src/data/deployment";

declare const __LAUNCH_MS__: number | undefined;
declare const __MAINNET_INDEXER__: string | undefined;

const launchAt = (): number => (typeof __LAUNCH_MS__ === "number" ? __LAUNCH_MS__ : MAINNET_LAUNCH_MS);
const indexer = (): string => (typeof __MAINNET_INDEXER__ === "string" ? __MAINNET_INDEXER__ : "https://indexer-a.ootle.tari.com");

const RECHECK_MS = 15_000;
let moved = false;
let lastCheck = -Infinity;

/** The answer is remembered per isolate: yes for good, no for a few seconds, so a slow indexer can't slow every request. */
async function mainnetIsServing(now: number, get: typeof fetch): Promise<boolean> {
  if (now - lastCheck < RECHECK_MS) return false;
  lastCheck = now;
  try {
    const r = await get(`${indexer()}/network`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    return ((await r.json()) as { network_byte?: unknown }).network_byte === 0;
  } catch {
    return false;
  }
}

export async function onMainnet(now: number = Date.now(), get: typeof fetch = fetch): Promise<boolean> {
  if (BUILD_NETWORK !== "auto") return BUILD_NETWORK === "mainnet";
  if (moved) return true;
  if (now < launchAt()) return false;
  // Contracts can only be published once mainnet is up, so if they're in this build there's nothing left to wait for.
  if (!mainnetPublished() && !(await mainnetIsServing(now, get))) return false;
  moved = true;
  useMainnet();
  return true;
}

/** What open pages poll, to reload themselves at the switch. */
export const networkResponse = (): Response =>
  new Response(JSON.stringify({ network: DEPLOYMENT.walletNetwork }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The same request for a different path, used to serve the mainnet build of a page. */
export const atPath = (req: Request, path: string): Request => new Request(new URL(path, req.url), req);

/** For tests. */
export function resetNetworkState(): void {
  moved = false;
  lastCheck = -Infinity;
}
