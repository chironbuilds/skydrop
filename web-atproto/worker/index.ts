// The site is static. This exists to send every response through the shared security layer.
import { fullPageRequest, httpsRedirect, secure } from "./secure";

interface Env {
  ASSETS: { fetch(r: Request): Promise<Response> };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return httpsRedirect(req) ?? secure(await env.ASSETS.fetch(fullPageRequest(req)));
  },
};
