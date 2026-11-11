/**
 * Skydrop Launcher — Durable Object that tracks the mainnet launch and reports progress.
 *
 * The DO sets an alarm for 04:40 UTC 2026-11-11 (or whenever /arm is called). When the alarm
 * fires it polls the mainnet indexer every 90 s, and once it sees mainnet AND finds addresses
 * written to KV (by launch-deploy.mjs on the user's machine or VPS), it marks the launch done.
 *
 * Endpoints (all CORS-open for the status page):
 *   GET  /           → HTML status page (countdown / in-progress / done)
 *   GET  /status     → {"phase":"pending"|"waiting"|"indexer_live"|"done","addresses":null|{...},"log":[...]}
 *   POST /arm        → arm the alarm (Bearer LAUNCH_WEBHOOK_SECRET); returns {"armed":true,"at":"..."}
 *   POST /complete   → called by launch-deploy.mjs after a successful deploy; body {addresses:{...}}
 */

export { LaunchController };

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  LAUNCH_CTL: DurableObjectNamespace;
  LAUNCH_STATE: KVNamespace;
  LAUNCH_WEBHOOK_SECRET?: string;
}

const MAINNET_INDEXER = "https://indexer-a.ootle.tari.com";
// Arm at 04:40 UTC, launch at 05:00:00 UTC 2026-11-11
const LAUNCH_MS = Date.UTC(2026, 10, 11, 5,  0,  0);
const ALARM_MS  = Date.UTC(2026, 10, 11, 4, 40,  0);
const POLL_INTERVAL_MS = 90_000;

type Phase = "pending" | "armed" | "waiting" | "indexer_live" | "done" | "error";

interface DOState {
  phase: Phase;
  armedAt?: string;
  indexerLiveAt?: string;
  doneAt?: string;
  error?: string;
  log: string[];
}

class LaunchController {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async getState(): Promise<DOState> {
    return (await this.state.storage.get<DOState>("s")) ?? { phase: "pending", log: [] };
  }

  private async saveState(s: DOState): Promise<void> {
    await this.state.storage.put("s", s);
  }

  private async appendLog(s: DOState, msg: string): Promise<void> {
    s.log = [...s.log.slice(-49), `[${new Date().toISOString()}] ${msg}`];
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cors = { "access-control-allow-origin": "*" };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET,POST", "access-control-allow-headers": "Authorization,Content-Type" } });
    }

    if (url.pathname === "/status") {
      const s = await this.getState();
      const addresses = await this.env.LAUNCH_STATE.get("mainnet:addresses").catch(() => null);
      return new Response(JSON.stringify({ phase: s.phase, armedAt: s.armedAt, indexerLiveAt: s.indexerLiveAt, doneAt: s.doneAt, error: s.error, log: s.log, addresses: addresses ? JSON.parse(addresses) : null }), { headers: { "content-type": "application/json", ...cors, "cache-control": "no-store" } });
    }

    if (url.pathname === "/arm" && req.method === "POST") {
      const secret = this.env.LAUNCH_WEBHOOK_SECRET;
      if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
      const alarmTime = Math.max(ALARM_MS, Date.now() + 5000);
      await this.state.storage.setAlarm(alarmTime);
      const s = await this.getState();
      s.phase = "armed";
      s.armedAt = new Date().toISOString();
      await this.appendLog(s, `Armed — alarm set for ${new Date(alarmTime).toISOString()}`);
      await this.saveState(s);
      return new Response(JSON.stringify({ armed: true, at: new Date(alarmTime).toISOString() }), { headers: { "content-type": "application/json", ...cors } });
    }

    if (url.pathname === "/complete" && req.method === "POST") {
      const secret = this.env.LAUNCH_WEBHOOK_SECRET;
      if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
      const body = await req.json<{ addresses?: { campaignTemplate?: string; linkRegistry?: string; verifier?: string } }>().catch(() => ({} as { addresses?: { campaignTemplate?: string; linkRegistry?: string; verifier?: string } }));
      const s = await this.getState();
      s.phase = "done";
      s.doneAt = new Date().toISOString();
      await this.appendLog(s, `Deploy complete. campaignTemplate: ${body.addresses?.campaignTemplate ?? "?"}`);
      await this.saveState(s);
      if (body.addresses) {
        await this.env.LAUNCH_STATE.put("mainnet:addresses", JSON.stringify(body.addresses)).catch(() => {});
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", ...cors } });
    }

    // Status HTML page
    const s = await this.getState();
    const addresses = await this.env.LAUNCH_STATE.get("mainnet:addresses").catch(() => null);
    const now = Date.now();
    const msLeft = LAUNCH_MS - now;
    const timeStr = msLeft > 0
      ? `Launch in ${Math.floor(msLeft / 3600000)}h ${Math.floor((msLeft % 3600000) / 60000)}m`
      : s.phase === "done" ? "LAUNCHED" : "Waiting for indexer…";
    const addrHtml = addresses
      ? `<pre>${JSON.stringify(JSON.parse(addresses), null, 2)}</pre>`
      : "<em>Addresses not yet published</em>";
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Skydrop Launch</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 20px;background:#0d0d1a;color:#e0e0f0}h1{color:#9f7aff}code,pre{background:#1a1a2e;padding:4px 8px;border-radius:4px;font-size:13px;color:#a0e0a0}pre{padding:12px;overflow:auto}.phase{font-size:1.4em;font-weight:bold;color:#ffd700}.log{font-size:12px;opacity:.7;margin-top:16px}li{list-style:none;padding:2px 0}</style>
</head><body>
<h1>Skydrop Launch Status</h1>
<p class="phase">${timeStr}</p>
<p>Phase: <strong>${s.phase}</strong></p>
${s.doneAt ? `<p>Completed: ${s.doneAt}</p>` : ""}
${s.error ? `<p style="color:red">Error: ${s.error}</p>` : ""}
<h3>Contract Addresses</h3>${addrHtml}
<div class="log"><h3>Log</h3><ul>${s.log.map(l => `<li>${l}</li>`).join("")}</ul></div>
<script>setTimeout(()=>location.reload(),30000)</script>
</body></html>`, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store", ...cors } });
  }

  async alarm(): Promise<void> {
    const s = await this.getState();

    // Check if already done
    if (s.phase === "done") return;

    // Check if addresses are already in KV (launch-deploy.mjs wrote them)
    const addresses = await this.env.LAUNCH_STATE.get("mainnet:addresses").catch(() => null);
    if (addresses) {
      s.phase = "done";
      s.doneAt = new Date().toISOString();
      await this.appendLog(s, "Addresses found in KV — launch complete!");
      await this.saveState(s);
      return;
    }

    // Poll the mainnet indexer
    try {
      const r = await fetch(`${MAINNET_INDEXER}/network`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const body = await r.json<{ network_byte?: number; network?: string }>();
        await this.appendLog(s, `Indexer replied: ${JSON.stringify(body)}`);
        const isMainnet = body.network_byte === 0 || body.network === "mainnet";
        if (isMainnet) {
          if (s.phase !== "indexer_live") {
            s.phase = "indexer_live";
            s.indexerLiveAt = new Date().toISOString();
            await this.appendLog(s, "Mainnet indexer is live! Waiting for launch-deploy.mjs to publish contracts…");
          } else {
            await this.appendLog(s, "Mainnet live, still waiting for contracts…");
          }
        } else {
          s.phase = "waiting";
          await this.appendLog(s, `Not mainnet yet (network_byte=${body.network_byte} network=${body.network})`);
        }
      } else {
        s.phase = "waiting";
        await this.appendLog(s, `Indexer returned ${r.status} — not up yet`);
      }
    } catch (e: unknown) {
      s.phase = "waiting";
      await this.appendLog(s, `Indexer not reachable: ${e instanceof Error ? e.message : String(e)}`);
    }

    await this.saveState(s);
    // Schedule next poll
    await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const id = env.LAUNCH_CTL.idFromName("main");
    const stub = env.LAUNCH_CTL.get(id);
    // Proxy to DO; pass Authorization header through
    return stub.fetch(req);
  },
};
