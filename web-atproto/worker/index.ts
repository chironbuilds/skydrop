// The site is static. This exists to send every response through the shared security layer.
import { atPath, networkResponse, onMainnet } from "./network";
import { fullPageRequest, httpsRedirect, secure } from "./secure";

interface KVNamespace { get(key: string): Promise<string | null> }
interface Env {
  ASSETS: { fetch(r: Request): Promise<Response> };
  LAUNCH_STATE?: KVNamespace;
}

// Cache resolved addresses per isolate so we don't hit KV on every request.
let cachedAddrs: string | null = null;
let addrsFetchedAt = 0;
const ADDRS_TTL_MS = 2 * 60 * 1000;

async function getAddresses(launchState: KVNamespace | undefined): Promise<string | null> {
  if (!launchState) return null;
  const now = Date.now();
  if (cachedAddrs !== null || (addrsFetchedAt > 0 && now - addrsFetchedAt < ADDRS_TTL_MS)) return cachedAddrs;
  cachedAddrs = await launchState.get("mainnet:addresses").catch(() => null);
  addrsFetchedAt = now;
  return cachedAddrs;
}

async function injectAddresses(res: Response, addrs: string): Promise<Response> {
  const script = `<script>window.__SD_ADDR__=${addrs}</script>`;
  const html = await res.text();
  const patched = html.includes("</head>") ? html.replace("</head>", script + "</head>") : script + html;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(patched, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const upgrade = httpsRedirect(req);
    if (upgrade) return upgrade;
    const path = new URL(req.url).pathname;
    const mainnet = await onMainnet();
    if (path === "/__network") return secure(networkResponse());
    // Everything without a file extension is a page of the single-page app, except the post at /thesis.
    const isPage = !/\.[a-z0-9]+$/i.test(path) && path !== "/thesis" && !path.startsWith("/thesis/");
    const assetRes = await env.ASSETS.fetch(fullPageRequest(mainnet && isPage ? atPath(req, "/mainnet/") : req));
    if (mainnet && isPage) {
      const addrs = await getAddresses(env.LAUNCH_STATE);
      if (addrs) return secure(await injectAddresses(assetRes, addrs));
    }
    return secure(assetRes);
  },
};
