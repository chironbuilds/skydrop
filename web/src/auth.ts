// "Continue with Bluesky": Bluesky's own sign-in (OAuth), so Skydrop can make the one proof post for you and delete it
// as soon as it has done its job. Nobody copies codes into Bluesky, and nothing stays on anyone's profile or feed.
//
// Only the post is ever touched: Skydrop asks for permission to create and delete posts, nothing else, where the
// account's server supports asking that narrowly. This module is loaded on demand, so the rest of the site doesn't
// carry the sign-in library.
import { BrowserOAuthClient, type OAuthSession } from "@atproto/oauth-client-browser";

/** The narrow permission first; the broad one only for servers that don't understand narrow ones yet. */
const NARROW_SCOPE = "atproto repo:app.bsky.feed.post?action=create&action=delete";
const BROAD_SCOPE = "atproto transition:generic";
const RETURN_KEY = "skydrop.authReturn";
const DID_KEY = "skydrop.authDid";
const POSTS_KEY = "skydrop.autoPosts";

let client: Promise<BrowserOAuthClient> | null = null;
function getClient(): Promise<BrowserOAuthClient> {
  client ??= BrowserOAuthClient.load({
    clientId: `${location.origin}/oauth-client-metadata.json`,
    handleResolver: "https://bsky.social",
    // the callback arrives in the URL fragment, which the site's own router would otherwise read as a page
    responseMode: "fragment",
  });
  return client;
}

/** Whether the URL is Bluesky sending someone back after signing in. */
export const isCallback = (): boolean => {
  const p = new URLSearchParams(location.hash.slice(1));
  return p.has("state") && (p.has("code") || p.has("error"));
};

/**
 * Finishes a sign-in that just came back, and puts the page back where the person left it. Returns the signed-in DID,
 * or throws with a message worth showing (they said no, the server refused).
 */
export async function finishSignIn(): Promise<string | null> {
  const c = await getClient();
  let back = "";
  try {
    back = sessionStorage.getItem(RETURN_KEY) ?? "";
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* no saved place: home */
  }
  try {
    const r = await c.init();
    if (!r) return null;
    localStorage.setItem(DID_KEY, r.session.did);
    return r.session.did;
  } finally {
    history.replaceState(null, "", `${location.pathname}${location.search}${back.startsWith("#/") ? back : "#/"}`);
  }
}

/** Who is signed in on this browser, without loading anything (the library keeps the actual session). */
export const signedInDid = (): string => {
  try {
    return localStorage.getItem(DID_KEY) ?? "";
  } catch {
    return "";
  }
};

/** Sends the person to Bluesky to approve, and back to `returnHash` afterwards. Never returns normally. */
export async function signIn(handle: string, returnHash: string): Promise<void> {
  const c = await getClient();
  try {
    sessionStorage.setItem(RETURN_KEY, returnHash);
  } catch {
    /* they land on the home page instead */
  }
  try {
    await c.signInRedirect(handle, { scope: NARROW_SCOPE });
  } catch (e) {
    // A server that predates narrow permissions refuses the request before anyone is sent anywhere.
    if (/scope/i.test(String(e))) await c.signInRedirect(handle, { scope: BROAD_SCOPE });
    throw e;
  }
}

export async function signOut(): Promise<void> {
  const did = signedInDid();
  try {
    localStorage.removeItem(DID_KEY);
  } catch {
    /* already gone */
  }
  if (!did) return;
  try {
    await (await getClient()).revoke(did);
  } catch {
    /* the session is dropped locally either way */
  }
}

async function session(did: string): Promise<OAuthSession> {
  if (signedInDid() !== did) throw new Error("Sign in with this Bluesky account first.");
  try {
    return await (await getClient()).restore(did);
  } catch {
    try {
      localStorage.removeItem(DID_KEY);
    } catch {
      /* ignore */
    }
    throw new Error("Your Bluesky sign-in has expired. Sign in again.");
  }
}

async function xrpc(s: OAuthSession, method: string, body: unknown): Promise<unknown> {
  const r = await s.fetchHandler(`/xrpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!r.ok) throw new Error(out.message || out.error || `Bluesky said no (${r.status})`);
  return out;
}

interface AutoPost {
  did: string;
  rkey: string;
  at: number;
}
function readPosts(): AutoPost[] {
  try {
    return JSON.parse(localStorage.getItem(POSTS_KEY) ?? "[]") as AutoPost[];
  } catch {
    return [];
  }
}
function writePosts(list: AutoPost[]): void {
  try {
    localStorage.setItem(POSTS_KEY, JSON.stringify(list.slice(-20)));
  } catch {
    /* it just won't be cleaned up automatically */
  }
}

/** Posts `text` from the signed-in account and remembers it, so it can be deleted once it has done its job. */
export async function postFor(did: string, text: string): Promise<{ uri: string; rkey: string }> {
  const s = await session(did);
  const out = (await xrpc(s, "com.atproto.repo.createRecord", {
    repo: did,
    collection: "app.bsky.feed.post",
    record: { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), langs: ["en"] },
  })) as { uri: string };
  const rkey = out.uri.split("/").pop()!;
  writePosts([...readPosts(), { did, rkey, at: Date.now() }]);
  return { uri: out.uri, rkey };
}

/** Whether Skydrop made a post for this account that it hasn't deleted yet. */
export const hasPendingPosts = (did: string): boolean => readPosts().some((p) => p.did === did);

/** Deletes the posts Skydrop made for this account. Returns how many went. Quietly keeps any it couldn't delete. */
export async function deletePostsFor(did: string): Promise<number> {
  const mine = readPosts().filter((p) => p.did === did);
  if (!mine.length) return 0;
  const s = await session(did);
  let gone = 0;
  const left: AutoPost[] = [];
  for (const p of mine) {
    try {
      await xrpc(s, "com.atproto.repo.deleteRecord", { repo: did, collection: "app.bsky.feed.post", rkey: p.rkey });
      gone++;
    } catch {
      left.push(p);
    }
  }
  writePosts([...readPosts().filter((p) => p.did !== did), ...left]);
  return gone;
}
