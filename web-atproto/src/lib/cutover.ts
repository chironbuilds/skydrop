import { DEPLOYMENT, isTestnetHost, MAINNET_LAUNCH_MS } from "../data/deployment";

const RELOADED = "skydrop-cutover-reloaded";

/** A testnet page left open on a main domain reloads itself into mainnet when the site switches, once per tab. */
export function watchForMainnet(): void {
  if (DEPLOYMENT.isMainnet || isTestnetHost(location.hostname) || location.hostname === "localhost" || location.hostname === "127.0.0.1") return;
  const check = async (): Promise<void> => {
    if (Date.now() < MAINNET_LAUNCH_MS) return;
    try {
      const r = await fetch("/__network", { cache: "no-store" });
      const { network } = (await r.json()) as { network?: string };
      if (network !== "mainnet" || sessionStorage.getItem(RELOADED)) return;
      sessionStorage.setItem(RELOADED, "1");
      location.reload();
    } catch {
      /* offline, or storage is blocked: without the guard a reload could repeat, so stay put */
    }
  };
  void check();
  setInterval(() => void check(), 20_000);
}
