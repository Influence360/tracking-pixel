import { Tracker } from './tracker';

/** Default collector URL, baked at build time (see build.mjs `--define`). */
declare const __INFLUENCE360_COLLECT_URL__: string;

/**
 * Browser entry point — bundled to `dist/influence360.js` and loaded async by the bootstrap stub
 * (see snippet/bootstrap.html). Drains any calls the stub queued in `window.influence360.q` before
 * this script arrived, then replaces the global with the real dispatcher.
 */
type Influence360Global = ((...args: unknown[]) => void) & {
  q?: unknown[];
  /** Web3: the ERC-8021 referral calldata suffix to append to the user's tx (see Tracker.referralTag). */
  referralTag?: () => string;
  /**
   * Web3: the canonical message to sign for a verified wallet binding (see `bindingMessage`). Reads the
   * captured ref id itself, so the caller only supplies what it knows — the connected wallet, its chain,
   * and the issue time it will pass back to `identify`. Returns '' when no referral was captured (nothing
   * to bind, so nothing to sign).
   */
  bindingMessage?: (
    wallet: string,
    chain: string | null,
    signedAtMs: number,
  ) => string;
};

(function bootstrap(win: Window & { influence360?: Influence360Global }): void {
  const tracker = new Tracker(__INFLUENCE360_COLLECT_URL__);
  const queued = (win.influence360 && win.influence360.q) || [];

  const dispatcher: Influence360Global = function (...args: unknown[]): void {
    tracker.dispatch(args);
  };
  // Synchronous accessors (not queued commands) — dApps call these inline while constructing a
  // transaction / prompting the wallet, so they must return a value rather than go through dispatch().
  dispatcher.referralTag = () => tracker.referralTag();
  dispatcher.bindingMessage = (wallet, chain, signedAtMs) =>
    tracker.bindingMessage(wallet, chain, signedAtMs);

  win.influence360 = dispatcher;

  for (const call of queued) {
    // Each queued entry is the `arguments` of an original influence360(...) call.
    tracker.dispatch(Array.prototype.slice.call(call as ArrayLike<unknown>));
  }
})(window as Window & { influence360?: Influence360Global });
