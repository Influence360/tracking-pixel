/**
 * The event wire-contract shared by the pixel and the collector (`POST /public/pixel/conversion`).
 * This file is the source of truth for the pixel side; the collector's request DTO must declare every
 * field sent here. That invariant is enforced by a strict-parse contract test on the collector side — a
 * field added here that the DTO doesn't declare fails that test rather than being silently dropped.
 */
/**
 * Conversion-type-specific fields, keyed by `type` (the conversion action). Mirrors the collector's
 * per-type conversion content and the server-to-server postback body — the same envelope +
 * per-type-content shape. Only the fields a given type uses are sent; the collector ignores the rest.
 */
export interface ConversionContent {
  /** The conversion action type, e.g. "SIGN_UP" | "PURCHASE" | "SUBSCRIPTION". */
  type: string;
  /**
   * The type-specific conversion amount, one field per value-gated type. Sent as a STRING (money-as-string
   * wire contract): the collector parses it to BigDecimal, so pinning it as a string end-to-end avoids the
   * number→String→BigDecimal type drift. The matching public `track()` option is a string too, so the amount
   * is a string from the caller all the way to the collector (no float rounding). Only the field for the
   * reported `type` is sent; the collector ignores the rest.
   */
  /** Order value, for PURCHASE. */
  orderValue?: string | null;
  /** Deposit value, for DEPOSIT. */
  depositValue?: string | null;
  /** Subscribed plan identifier, for SUBSCRIPTION (required — the payout is plan-driven, no amount is sent). */
  qualifyingPlan?: string | null;
}

export interface CollectEvent {
  // The public, non-secret company token is NOT part of this body — it rides as the `publicToken` query
  // param on the beacon URL (Meta pixel / GA4 style), so the collector resolves the tenant before parsing
  // the body and it stays out of the wire-contract key set.
  /** The ref id minted by our redirect (from the `_influence360_ref_id` first-party cookie), or null. */
  refId: string | null;
  /** Idempotency key from the company (hashed email / order id), or null. */
  dedupKey: string | null;
  /** The page URL the event fired on (the Meta CAPI `event_source_url` analog). */
  eventSourceUrl: string;
  /**
   * When the pixel observed the event on the client, ms since the Unix epoch. Untrusted/diagnostic: the
   * collector server-stamps the authoritative `occurredAtMs`, so this never drives billing or attribution.
   */
  clientEventAtMs: number;
  /** Canary/test flag; null when absent. A test conversion is validated downstream but never billed. */
  test: boolean | null;
  /** The conversion-type-specific payload, keyed by its `type`. */
  content: ConversionContent;
}

/** Options accepted by `influence360('track', event, options)`. */
export interface TrackOptions {
  dedupKey?: string;
  /** Order value, for PURCHASE. A money-as-string amount, e.g. '49.99'. */
  orderValue?: string;
  /** Deposit value, for DEPOSIT. A money-as-string amount, e.g. '49.99'. */
  depositValue?: string;
  /** Subscribed plan identifier, for SUBSCRIPTION (required — the payout is plan-driven, no amount is sent). */
  qualifyingPlan?: string;
  /** Canary/test conversion from the verification panel: validated downstream but never billed. */
  test?: boolean;
}

/** Options accepted by `influence360('identify', wallet, options)`. */
export interface IdentifyOptions {
  /**
   * The chain of the connected wallet, e.g. "ETHEREUM" | "SOLANA" | "TRON". Optional metadata for an
   * unsigned binding — but REQUIRED alongside `signature`, since it selects the collector's verifier.
   */
  chain?: string;
  /** Canary/test identify from the verification panel: validated downstream but never billed. */
  test?: boolean;
  /**
   * Hex signature over `bindingMessage(...)`, proving the visitor controls `wallet`. Send it with
   * `signedAtMs` to produce a VERIFIED binding — the only kind that attributes under the company's
   * REQUIRE_SIGNED strictness, and the one that wins under PREFER_SIGNED.
   *
   * The SDK deliberately does not sign for you: signing is chain- and wallet-library-specific (EVM
   * `personal_sign` vs Solana ed25519 vs WalletConnect sessions), and reaching into an injected
   * provider from here would both bloat the bundle and break every non-EVM dApp. Build the message
   * with `influence360.bindingMessage(...)`, sign it with the wallet client you already have, pass
   * the result here.
   */
  signature?: string;
  /**
   * Epoch ms the signature was issued — must be the SAME value passed to `bindingMessage(...)` as
   * `signedAtMs`, since it is signed into the message and bounds replay. Required with `signature`.
   */
  signedAtMs?: number;
}

/**
 * Wallet↔ref binding beacon sent by `identify(...)`. Binds the wallet the visitor connected on the
 * destination page to the referral they arrived with (the ref-id cookie), so an untagged on-chain
 * conversion from that wallet attributes to the referring creator (wallet-at-activity). Ingested by
 * the collector's `POST /public/pixel/identify`, which stamps the bind time server-side.
 */
export interface IdentifyEvent {
  // The public token rides as the `publicToken` query param on the beacon URL, same as the conversion pixel.
  /** The ref id from the `_influence360_ref_id` first-party cookie (the participation arrived through). */
  refId: string;
  /** The wallet address the visitor connected on the destination page. */
  wallet: string;
  /** The chain of the connected wallet, or null. */
  chain: string | null;
  /** Canary/test flag; null when absent. */
  test: boolean | null;
  /**
   * Hex signature over the canonical binding message, or null. Present + valid + fresh → the collector
   * stores the binding `verified`; absent/invalid → stored unverified (still attributes unless the
   * company requires signed bindings).
   */
  signature: string | null;
  /** Epoch ms the signature was issued (the `issuedAt` in the signed message), or null. */
  signedAtMs: number | null;
}

/** Options accepted by `influence360('init', publicToken, options)`. */
export interface InitOptions {
  /** Override the collector URL (e.g. to route events through your own first-party proxy). */
  collectUrl?: string;
  /** Override the wallet-identify URL (defaults to the collector URL with `/conversion` → `/identify`). */
  identifyUrl?: string;
  /**
   * Registrable domain to scope the ref cookie to (e.g. `example.com`), so a click captured on one subdomain
   * is readable when the conversion fires on another. Omit to best-effort auto-detect; set explicitly when the
   * auto-detect can't (unusual multi-level domains) or to pin the exact scope.
   */
  cookieDomain?: string;
  /**
   * The 16-byte ERC-8021 attribution marker (hex) for deterministic on-chain tags. When set, a web3 dApp can
   * call `influence360.referralTag()` to get a calldata suffix to append to the user's transaction, so the
   * on-chain conversion carries the referral tag directly (path #1). Omit to disable (returns '').
   */
  erc8021Marker?: string;
}
