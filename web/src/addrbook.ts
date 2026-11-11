/**
 * Shows wallets by their otl_ address rather than their account (component_…) address.
 *
 * The chain only ever names accounts, and an otl_ address can't be worked out from one: it also carries the wallet's
 * view key. So this remembers the otl_ address of every wallet this browser has seen (its own Skydrop wallet, a
 * connected Sapient, an address pasted to link), and falls back to the account address for any other wallet.
 */
const KEY = "skydrop:otl-book";
const MAX = 50;

let book: Record<string, string> = {};
try {
  book = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
} catch {
  book = {};
}

/** Remembers that `account` (component_…) is the wallet with this otl_ address. */
export function rememberAddress(account: string | null | undefined, otl: string | null | undefined): void {
  if (!account || !otl || !otl.startsWith("otl_") || book[account] === otl) return;
  book[account] = otl;
  const keys = Object.keys(book);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete book[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(book));
  } catch {
    /* kept for this visit only */
  }
}

/** The otl_ address of an account, when this browser knows it. */
export const otlOf = (account: string): string | null => book[account] ?? null;

/** An account shortened for display, by its otl_ address when known. */
export function displayAddress(account: string, head = 14, tail = 6): string {
  const a = otlOf(account) ?? account;
  return a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}
