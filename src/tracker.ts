import type {
  CollectEvent,
  IdentifyEvent,
  IdentifyOptions,
  InitOptions,
  TrackOptions,
} from './types';

/** URL query param carrying the ref id, appended by the tracking-link redirect to the landing page. */
export const REF_PARAM = 'influence360RefId';
/** First-party cookie the ref id is persisted into, on the company's own domain. */
export const COOKIE_NAME = '_influence360_ref_id';
/** localStorage key mirroring the ref cookie — a same-origin longevity fallback when the cookie is evicted. */
export const STORAGE_KEY = '_influence360_ref_id';
/** How long the referral cookie survives — the attribution window upper bound. */
export const COOKIE_TTL_DAYS = 90;

/** Reads a cookie value by name, or null if absent. */
export function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const parts = document.cookie ? document.cookie.split('; ') : [];
  for (const part of parts) {
    if (part.indexOf(prefix) === 0) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

/**
 * Writes a first-party cookie (Lax, Secure, site-wide path) with a day-based expiry. When `domain` is given the
 * cookie is scoped to that registrable domain so it is shared across the company's subdomains (a click captured
 * on `www.` is then readable when the conversion fires on `app.`); host-only when omitted.
 */
export function writeCookie(
  name: string,
  value: string,
  days: number,
  domain?: string,
): void {
  const maxAge = days * 24 * 60 * 60;
  const scope = domain ? `; Domain=${domain}` : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/${scope}; SameSite=Lax; Secure`;
}

/** Reads a localStorage value, tolerating disabled/blocked storage (private mode, quota, sandbox). */
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes a localStorage value, swallowing any storage error (must never throw into the host page). */
function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / disabled / quota — the cookie remains the primary store.
  }
}

/**
 * The registrable domain a first-party cookie should be scoped to, so it is shared across subdomains — best
 * effort without a public-suffix list: probe candidate parent domains from broadest to narrowest and return the
 * first the browser actually lets us set a cookie on. Browsers refuse `Domain=<public suffix>` (e.g. `co.uk`),
 * so the first that sticks is the true registrable domain (`example.co.uk`, `example.com`). Returns null for IP
 * literals and single-label hosts (e.g. `localhost`), where the cookie stays host-only.
 */
export function registrableDomain(hostname: string): string | null {
  if (!hostname || /^[0-9.]+$/.test(hostname) || hostname.indexOf('.') < 0) {
    return null;
  }
  const parts = hostname.split('.');
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = parts.slice(i).join('.');
    if (canSetCookieOnDomain(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Whether the browser accepts a cookie scoped to `domain` from the current page (probe + immediate cleanup). */
function canSetCookieOnDomain(domain: string): boolean {
  try {
    const probe = '__influence360_d';
    document.cookie = `${probe}=1; Domain=${domain}; Path=/; SameSite=Lax`;
    const accepted = document.cookie.indexOf(`${probe}=`) >= 0;
    document.cookie = `${probe}=; Domain=${domain}; Path=/; Max-Age=0; SameSite=Lax`;
    return accepted;
  } catch {
    return false;
  }
}

/** Persists the ref id to the (domain-scoped) cookie AND localStorage, so attribution survives cookie eviction. */
export function storeRef(refId: string, domain: string | null): void {
  writeCookie(COOKIE_NAME, refId, COOKIE_TTL_DAYS, domain ?? undefined);
  writeStorage(STORAGE_KEY, refId);
}

/** The captured ref id: the cookie first (shared cross-subdomain), else the localStorage longevity fallback. */
export function readRef(): string | null {
  return readCookie(COOKIE_NAME) ?? readStorage(STORAGE_KEY);
}

/**
 * Reads `?influence360RefId=...` off the current URL and, if present, persists it to the first-party cookie
 * (scoped to `domain` when given) and localStorage. Idempotent and safe to call on every page load.
 */
export function captureClick(href: string, domain: string | null = null): void {
  const query = href.indexOf('?') >= 0 ? href.slice(href.indexOf('?') + 1) : '';
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    if (decodeURIComponent(key) === REF_PARAM) {
      const raw = eq >= 0 ? pair.slice(eq + 1) : '';
      const refId = decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
      if (refId) {
        storeRef(refId, domain);
      }
      return;
    }
  }
}

/** Assembles a {@link CollectEvent} from the tracker state + a track() call. */
export function buildEvent(
  refId: string | null,
  event: string,
  opts: TrackOptions,
  eventSourceUrl: string,
  clientEventAtMs: number,
): CollectEvent {
  const content: CollectEvent['content'] = {
    type: event,
  };
  // Money-as-string wire contract: each value-gated type carries its own amount field as a string, so the
  // collector's String field / BigDecimal parse is unambiguous and money stays a string end-to-end (no float
  // rounding). The public options are strings too; a stray number is still coerced defensively so the tracker
  // never drops a caller's amount. Only the field the caller set for this type is sent; the collector ignores
  // the rest, so an unset type carries no amount field.
  if (opts.orderValue != null) {
    content.orderValue = String(opts.orderValue);
  }
  if (opts.depositValue != null) {
    content.depositValue = String(opts.depositValue);
  }
  if (typeof opts.qualifyingPlan === 'string') {
    content.qualifyingPlan = opts.qualifyingPlan;
  }
  return {
    refId,
    dedupKey: opts.dedupKey ?? null,
    eventSourceUrl,
    clientEventAtMs,
    // Canary/test conversion from the verification panel; null when absent (validated downstream, never billed).
    test: typeof opts.test === 'boolean' ? opts.test : null,
    content,
  };
}

/** Lowercased hex of a UTF-8 string (no `0x`), used to encode the referral tag into calldata. */
function utf8ToHex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Build the ERC-8021-style referral calldata suffix a web3 dApp appends to the END of the user's transaction
 * calldata, so the on-chain conversion carries a deterministic, campaign-scoped referral tag (path #1) instead
 * of relying on the wallet-at-activity fallback. Layout — matching the collector's parse-from-end extractor:
 * `<tag bytes><tagLen:1 byte><schemaId:1 byte><marker:16 bytes>`. `refId` is the participation ref carried in
 * the referral link; `marker` is the 16-byte ERC-8021 marker (hex, with or without `0x`). Returns '' when
 * either is missing/invalid or the tag exceeds one length byte (255 bytes). No `0x` prefix — append verbatim
 * to the tx calldata's trailing hex.
 */
export function buildReferralCalldataSuffix(
  refId: string,
  marker: string,
): string {
  const normalizedMarker = (marker || '').replace(/^0x/i, '').toLowerCase();
  if (!refId || !/^[0-9a-f]{32}$/.test(normalizedMarker)) {
    return '';
  }
  const tagHex = utf8ToHex(refId);
  const tagBytes = tagHex.length / 2;
  if (tagBytes === 0 || tagBytes > 255) {
    return '';
  }
  const tagLenHex = tagBytes.toString(16).padStart(2, '0');
  const schemaIdHex = '01'; // our length-prefixed refId schema
  return `${tagHex}${tagLenHex}${schemaIdHex}${normalizedMarker}`;
}

/**
 * The exact message a wallet must sign to produce a VERIFIED binding. Must match the message the
 * collector reconstructs byte-for-byte: `\n`-joined, no trailing newline, and an empty `chain:` line when
 * no chain is given. Any deviation and the recovered address won't match, so the collector keeps the
 * binding but marks it unsigned.
 *
 * Exposed on the global as `influence360.bindingMessage(...)` so a dApp never hand-rolls this string. Pass
 * the SAME `signedAtMs` to `identify(...)` — it is signed into the message and bounds replay (the collector
 * rejects signatures outside a ~10 minute window).
 */
export function bindingMessage(
  refId: string,
  wallet: string,
  chain: string | null,
  signedAtMs: number,
): string {
  return (
    'influence360 wallet attribution\n' +
    'ref:' +
    refId +
    '\n' +
    'wallet:' +
    wallet +
    '\n' +
    'chain:' +
    (chain == null ? '' : chain) +
    '\n' +
    'issuedAt:' +
    signedAtMs
  );
}

/**
 * Assembles an {@link IdentifyEvent} from the tracker state + an identify() call. A signature is only
 * carried when BOTH `signature` and `signedAtMs` are present — half a proof can never verify, so sending
 * one without the other would just cost a round trip and land as unsigned anyway.
 */
export function buildIdentify(
  refId: string,
  wallet: string,
  opts: IdentifyOptions,
): IdentifyEvent {
  const signed =
    typeof opts.signature === 'string' &&
    opts.signature.length > 0 &&
    typeof opts.signedAtMs === 'number' &&
    isFinite(opts.signedAtMs);
  return {
    refId,
    wallet,
    chain: typeof opts.chain === 'string' ? opts.chain : null,
    test: typeof opts.test === 'boolean' ? opts.test : null,
    signature: signed ? (opts.signature as string) : null,
    signedAtMs: signed ? (opts.signedAtMs as number) : null,
  };
}

/**
 * The tracker. Holds the public token + collector URL and exposes the two commands the public
 * `influence360(...)` global dispatches to: `init` and `track`. Fire-and-forget — never blocks the page.
 */
export class Tracker {
  private publicToken: string | null = null;
  private identifyUrlOverride: string | null = null;
  private erc8021Marker: string | null = null;
  private cookieDomain: string | null = null;

  constructor(private collectUrl: string) {}

  init(publicToken: string, opts: InitOptions = {}): void {
    this.publicToken = publicToken;
    if (opts.collectUrl) {
      this.collectUrl = opts.collectUrl;
    }
    if (opts.identifyUrl) {
      this.identifyUrlOverride = opts.identifyUrl;
    }
    if (opts.erc8021Marker) {
      this.erc8021Marker = opts.erc8021Marker;
    }
    // Scope the ref cookie to the registrable domain so a click captured on one subdomain is readable when the
    // conversion fires on another. Explicit `cookieDomain` wins; otherwise best-effort auto-detect.
    const host =
      typeof window !== 'undefined' && window.location
        ? window.location.hostname
        : '';
    this.cookieDomain = opts.cookieDomain ?? registrableDomain(host);
    captureClick(window.location.href, this.cookieDomain);
  }

  /**
   * The ERC-8021 referral calldata suffix for the ref this visitor arrived with (read from the cookie), for a
   * web3 dApp to append to the END of the user's transaction calldata — so the on-chain conversion carries a
   * deterministic, campaign-scoped referral tag (path #1). Returns '' when there is no captured ref or no
   * configured marker (`init({ erc8021Marker })`). Synchronous; safe to call while building a tx.
   */
  referralTag(): string {
    const refId = readRef();
    if (!refId || !this.erc8021Marker) {
      return '';
    }
    return buildReferralCalldataSuffix(refId, this.erc8021Marker);
  }

  /**
   * The canonical message to sign for a verified binding of `wallet`, for the referral this visitor
   * arrived with (read from the cookie). Returns '' when there is no captured ref — there is nothing to
   * bind, so signing would be pointless. Synchronous; safe to call while prompting the wallet.
   */
  bindingMessage(
    wallet: string,
    chain: string | null,
    signedAtMs: number,
  ): string {
    const refId = readRef();
    if (!refId || !wallet) {
      return '';
    }
    return bindingMessage(refId, wallet, chain, signedAtMs);
  }

  track(event: string, opts: TrackOptions = {}): void {
    const body = buildEvent(
      readRef(),
      event,
      opts,
      window.location.href,
      Date.now(),
    );
    this.post(this.withPublicToken(this.collectUrl), body);
  }

  /**
   * Binds the wallet the visitor just connected to the referral they arrived with (the ref-id cookie),
   * so an untagged on-chain conversion from that wallet attributes to the referring creator
   * (wallet-at-activity). Call after the user connects a wallet on the destination page. A no-op
   * when there is no captured ref id or no wallet — nothing to bind. Fire-and-forget; never blocks.
   *
   * Pass `signature` + `signedAtMs` (over {@link bindingMessage}) for a verified binding — required when
   * the company's attribution strictness is REQUIRE_SIGNED, and it beats an unsigned binding for the same
   * wallet under PREFER_SIGNED.
   */
  identify(wallet: string, opts: IdentifyOptions = {}): void {
    const refId = readRef();
    if (!refId || !wallet) {
      return;
    }
    this.post(
      this.withPublicToken(this.identifyUrl()),
      buildIdentify(refId, wallet, opts),
    );
  }

  /** The wallet-identify URL: the explicit override, else the collector URL with `/conversion` → `/identify`. */
  private identifyUrl(): string {
    return (
      this.identifyUrlOverride ??
      this.collectUrl.replace(/\/conversion$/, '/identify')
    );
  }

  /**
   * Appends the public token as the `publicToken` query param (Meta pixel / GA4 style), so the collector
   * resolves the owning company + its Origin/Referer allow-list before parsing the body. The token is
   * non-secret (it ships in the snippet), so query-string placement is acceptable and works with
   * `sendBeacon` / `<img>` beacons, which can't set headers.
   */
  private withPublicToken(url: string): string {
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    return `${url}${sep}publicToken=${encodeURIComponent(this.publicToken ?? '')}`;
  }

  /**
   * POSTs the JSON body as a `text/plain` beacon. text/plain is a CORS-safelisted content type, so
   * the cross-origin beacon skips the preflight (the collector parses the JSON text body). Uses
   * `navigator.sendBeacon` when available (survives page unload), falling back to keepalive fetch.
   */
  private post(url: string, body: CollectEvent | IdentifyEvent): void {
    const payload = JSON.stringify(body);
    try {
      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.sendBeacon === 'function'
      ) {
        const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(url, blob)) {
          return;
        }
      }
      void fetch(url, {
        method: 'POST',
        body: payload,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        keepalive: true,
        mode: 'no-cors',
      }).catch(() => {});
    } catch {
      // Tracking must never throw into the host page.
    }
  }

  /** Dispatches a single queued/live `influence360(cmd, ...args)` call. Unknown commands are ignored. */
  dispatch(args: unknown[]): void {
    const cmd = args[0];
    if (cmd === 'init') {
      this.init(args[1] as string, args[2] as InitOptions | undefined);
    } else if (cmd === 'track') {
      this.track(args[1] as string, args[2] as TrackOptions | undefined);
    } else if (cmd === 'identify') {
      this.identify(args[1] as string, args[2] as IdentifyOptions | undefined);
    }
  }
}
