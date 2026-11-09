/**
 * The security layer both sites share: every response goes through here. The pages drive wallet signing, so a framed,
 * downgraded or script-injected page is what this has to stop.
 *
 * Why connect-src can't be tighter: a proof is fetched from whichever server hosts the account (its PDS), and that can be
 * any https host. Everything else a page may load is named.
 */

/** Inline scripts are allowed by hash, worked out from the page itself, so a page and its policy can't drift apart. */
function policy(hashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${hashes.map((x) => ` '${x}'`).join("")}`,
    // Pages set a few styles inline through the DOM. A style can't run code or send a wallet's data anywhere here.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const ALWAYS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "cross-origin-opener-policy": "same-origin",
};

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest));
}

/** The hash of every inline script in a page, in the form a policy names them. */
export async function inlineHashes(html: string): Promise<string[]> {
  const out = new Set<string>();
  for (const m of html.matchAll(INLINE_SCRIPT)) if (m[1]) out.add(`sha256-${await sha256Base64(m[1])}`);
  return [...out];
}

const isLocal = (url: URL): boolean => url.hostname === "localhost" || url.hostname === "127.0.0.1";

/**
 * Plain http goes to https before anything else can be served over it. `wrangler dev` reports the production hostname,
 * so test the workers locally with `--local-protocol https`.
 */
export function httpsRedirect(req: Request): Response | null {
  const url = new URL(req.url);
  if (isLocal(url)) return null;
  if (url.protocol !== "http:" && req.headers.get("x-forwarded-proto") !== "http") return null;
  url.protocol = "https:";
  return new Response(null, { status: 301, headers: { location: url.href, "cache-control": "public, max-age=3600" } });
}

/** Adds the headers to a response, whichever part of the site made it. */
export async function secure(res: Response): Promise<Response> {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(ALWAYS)) headers.set(k, v);
  const isHtml = (headers.get("content-type") ?? "").includes("text/html");
  if (!isHtml) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  const html = res.body ? await res.text() : "";
  headers.set("content-security-policy", policy(await inlineHashes(html)));
  return new Response(res.body === null ? null : html, { status: res.status, statusText: res.statusText, headers });
}

/**
 * A page's validator would otherwise answer 304, and the browser would apply that response's policy to the page it kept.
 * A 304 has no body to hash, so its policy would refuse the page's inline scripts. Pages are always sent in full.
 */
export function fullPageRequest(req: Request): Request {
  if (!(req.headers.get("accept") ?? "").includes("text/html")) return req;
  const headers = new Headers(req.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(req, { headers });
}

/** A request body up to `max` bytes, or null if it's longer. It stops reading there, whatever the request claimed. */
export async function readCappedBytes(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

export async function readCapped(req: Request, max: number): Promise<string | null> {
  const bytes = await readCappedBytes(req, max);
  return bytes && new TextDecoder().decode(bytes);
}
