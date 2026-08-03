import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Reads a Blob's text via FileReader (jsdom's Blob has no .text()). */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

import {
  bindingMessage,
  buildEvent,
  buildIdentify,
  buildReferralCalldataSuffix,
  captureClick,
  COOKIE_NAME,
  readCookie,
  readRef,
  registrableDomain,
  STORAGE_KEY,
  storeRef,
  Tracker,
  writeCookie,
} from '../src/tracker';
import type { CollectEvent, IdentifyEvent } from '../src/types';

const COLLECT_URL = 'https://collect.example/public/pixel/conversion';

/** Reset both cookies and localStorage so a ref persisted by one test never leaks into the next. */
function clearCookies(): void {
  for (const part of document.cookie.split('; ')) {
    const name = part.split('=')[0];
    if (name) {
      document.cookie = `${name}=; Max-Age=0; Path=/`;
    }
  }
  // Deliberately unguarded: a broken `window.localStorage` (see test/setup.ts) must fail the suite loudly here,
  // not leak refs between tests behind a swallowed exception.
  window.localStorage.clear();
}

describe('cookie helpers', () => {
  beforeEach(clearCookies);

  it('round-trips a value', () => {
    writeCookie(COOKIE_NAME, 'click-123', 90);
    expect(readCookie(COOKIE_NAME)).toBe('click-123');
  });

  it('returns null when absent', () => {
    expect(readCookie('_missing')).toBeNull();
  });
});

describe('captureClick', () => {
  beforeEach(clearCookies);

  it('persists influence360RefId from the URL into the cookie', () => {
    captureClick(
      'https://shop.example/signup?utm=x&influence360RefId=abc-789&ref=1',
    );
    expect(readCookie(COOKIE_NAME)).toBe('abc-789');
  });

  it('does nothing when the param is absent', () => {
    captureClick('https://shop.example/signup?utm=x');
    expect(readCookie(COOKIE_NAME)).toBeNull();
  });
});

describe('registrableDomain', () => {
  it('returns null for IP literals and single-label hosts (no cookie domain scoping)', () => {
    expect(registrableDomain('203.0.113.5')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain('')).toBeNull();
  });
});

describe('ref persistence (cookie + localStorage fallback)', () => {
  beforeEach(clearCookies);

  it('reads the ref from localStorage when the cookie has been evicted', () => {
    storeRef('ref-persist', null);
    // Assert the mirror directly, not just via readRef(): storeRef swallows storage errors, so a readRef()-only
    // assertion would still pass off the cookie even if nothing was ever written to localStorage.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ref-persist');
    expect(readRef()).toBe('ref-persist');

    // Simulate the cookie being capped/cleared (e.g. Safari ITP) — the localStorage mirror still resolves.
    document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/`;
    expect(readCookie(COOKIE_NAME)).toBeNull();
    expect(readRef()).toBe('ref-persist');
  });

  it('prefers the cookie over localStorage when both are present', () => {
    storeRef('from-storage', null);
    writeCookie(COOKIE_NAME, 'from-cookie', 90);
    expect(readRef()).toBe('from-cookie');
  });
});

describe('buildEvent', () => {
  it('maps options to the wire-contract, sending only the type-specific amount field', () => {
    const event = buildEvent(
      'click-1',
      'PURCHASE',
      { dedupKey: 'hash', orderValue: '42' },
      'https://shop.example/joined',
      1700000000000,
    );
    expect(event).toStrictEqual<CollectEvent>({
      refId: 'click-1',
      dedupKey: 'hash',
      eventSourceUrl: 'https://shop.example/joined',
      clientEventAtMs: 1700000000000,
      test: null,
      content: {
        type: 'PURCHASE',
        orderValue: '42',
      },
    });
  });

  it('defensively coerces a stray numeric amount to a string (never drops it)', () => {
    const event = buildEvent(
      'click-1',
      'PURCHASE',
      // The public option is a string; a legacy caller passing a number must still land as a string.
      { orderValue: 42 as unknown as string },
      'u',
      1,
    );
    expect(event.content.orderValue).toBe('42');
  });

  it('emits exactly the wire-contract keys and round-trips the test flag', () => {
    // This key set is the contract the collector's request DTO must mirror (enforced there by a
    // strict-parse test). Keep it exhaustive so adding/removing a wire field fails here.
    const event = buildEvent(
      'click-1',
      'SIGN_UP',
      { test: true },
      'https://shop.example/joined',
      1700000000000,
    );
    expect(Object.keys(event).sort()).toStrictEqual(
      [
        'clientEventAtMs',
        'dedupKey',
        'content',
        'eventSourceUrl',
        'refId',
        'test',
      ].sort(),
    );
    expect(event.test).toBe(true);
  });

  it('carries qualifyingPlan in content when provided', () => {
    const event = buildEvent(
      null,
      'SUBSCRIPTION',
      { qualifyingPlan: 'pro-monthly' },
      'u',
      1,
    );
    expect(event.content).toStrictEqual({
      type: 'SUBSCRIPTION',
      qualifyingPlan: 'pro-monthly',
    });
  });

  it('omits the amount field and dedupKey when absent', () => {
    const event = buildEvent(null, 'PURCHASE', {}, 'u', 1);
    expect(event.dedupKey).toBeNull();
    expect(event.content.orderValue).toBeUndefined();
    expect(event.content.qualifyingPlan).toBeUndefined();
    expect(event.refId).toBeNull();
  });
});

describe('buildIdentify', () => {
  it('maps the wallet + options to the binding wire-contract, nulling absent fields', () => {
    expect(
      buildIdentify('click-1', '0xWALLET', {
        chain: 'ETHEREUM',
        test: true,
      }),
    ).toStrictEqual<IdentifyEvent>({
      refId: 'click-1',
      wallet: '0xWALLET',
      chain: 'ETHEREUM',
      test: true,
      signature: null,
      signedAtMs: null,
    });
  });

  it('nulls out an absent chain / test flag', () => {
    const event = buildIdentify('r', '0xw', {});
    expect(event.chain).toBeNull();
    expect(event.test).toBeNull();
  });

  it('carries a signature + signedAtMs through for a verified binding', () => {
    const event = buildIdentify('r', '0xw', {
      chain: 'ETHEREUM',
      signature: '0xdeadbeef',
      signedAtMs: 1700000000000,
    });
    expect(event.signature).toBe('0xdeadbeef');
    expect(event.signedAtMs).toBe(1700000000000);
  });

  // Half a proof can never verify, so it is dropped rather than sent — the collector would store the
  // binding unsigned either way, and dropping keeps the beacon honest about what it is claiming.
  it('drops a signature sent without signedAtMs (and vice versa)', () => {
    expect(
      buildIdentify('r', '0xw', { signature: '0xsig' }).signature,
    ).toBeNull();
    expect(
      buildIdentify('r', '0xw', { signedAtMs: 1700000000000 }).signedAtMs,
    ).toBeNull();
    expect(
      buildIdentify('r', '0xw', { signature: '', signedAtMs: 1 }).signature,
    ).toBeNull();
  });
});

describe('bindingMessage', () => {
  // Must stay byte-identical to the message the collector reconstructs — a single character of drift
  // and every signature verifies false (binding silently kept unsigned).
  it('builds the canonical message the collector reconstructs', () => {
    expect(bindingMessage('ref-1', '0xWALLET', 'ETHEREUM', 1700000000000)).toBe(
      'influence360 wallet attribution\n' +
        'ref:ref-1\n' +
        'wallet:0xWALLET\n' +
        'chain:ETHEREUM\n' +
        'issuedAt:1700000000000',
    );
  });

  it('renders an absent chain as an empty chain line, not "null"', () => {
    expect(bindingMessage('r', '0xw', null, 1)).toContain('\nchain:\n');
  });
});

describe('buildReferralCalldataSuffix', () => {
  const MARKER = '80218021802180218021802180218021'; // 16 bytes

  it('builds <tag><tagLen><schemaId=01><marker> from the refId', () => {
    // "abc" → 616263 (3 bytes → tagLen 03).
    expect(buildReferralCalldataSuffix('abc', MARKER)).toBe(
      `616263` + `03` + `01` + MARKER,
    );
  });

  it('accepts a 0x-prefixed marker and lowercases it', () => {
    expect(buildReferralCalldataSuffix('a', `0x${MARKER.toUpperCase()}`)).toBe(
      `61` + `01` + `01` + MARKER,
    );
  });

  it('returns empty for a missing ref or an invalid (non-16-byte) marker', () => {
    expect(buildReferralCalldataSuffix('', MARKER)).toBe('');
    expect(buildReferralCalldataSuffix('abc', 'deadbeef')).toBe('');
  });
});

describe('Tracker', () => {
  beforeEach(clearCookies);

  it('referralTag() returns the calldata suffix from the ref cookie + configured marker', () => {
    const tracker = new Tracker(COLLECT_URL);
    history.replaceState({}, '', '/app?influence360RefId=ref-9');
    tracker.init('site-1', {
      erc8021Marker: '80218021802180218021802180218021',
    });
    // "ref-9" → 7265662d39, 5 bytes → tagLen 05.
    expect(tracker.referralTag()).toBe(
      `7265662d39` + `05` + `01` + `80218021802180218021802180218021`,
    );
  });

  it('referralTag() returns empty when no marker configured or no ref captured', () => {
    const noMarker = new Tracker(COLLECT_URL);
    history.replaceState({}, '', '/app?influence360RefId=ref-9');
    noMarker.init('site-1');
    expect(noMarker.referralTag()).toBe('');

    clearCookies(); // drop the ref captured above so the next case truly has no ref
    const noRef = new Tracker(COLLECT_URL);
    history.replaceState({}, '', '/app');
    noRef.init('site-1', { erc8021Marker: '80218021802180218021802180218021' });
    expect(noRef.referralTag()).toBe('');
  });

  it('sends a parseable text/plain beacon to the collector with the captured ref id', async () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });

    const tracker = new Tracker(COLLECT_URL);
    // init on a landing URL captures the ref id...
    history.replaceState({}, '', '/signup?influence360RefId=clk-555');
    tracker.init('site-1');
    // ...then a conversion fires.
    tracker.track('PURCHASE', { dedupKey: 'order-1', orderValue: '10' });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0] as [string, Blob];
    // The public token rides as a query param on the beacon URL, not in the body.
    expect(url).toBe(`${COLLECT_URL}?publicToken=site-1`);
    expect(blob.type).toContain('text/plain');

    const body = JSON.parse(await blobText(blob)) as CollectEvent;
    expect(body).not.toHaveProperty('publicToken');
    expect(body.refId).toBe('clk-555');
    expect(body.dedupKey).toBe('order-1');
    expect(body.content.type).toBe('PURCHASE');
    expect(body.content.orderValue).toBe('10');

    vi.unstubAllGlobals();
  });

  it('sends a wallet-identify beacon to the /identify endpoint with the captured ref id', async () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });

    const tracker = new Tracker(COLLECT_URL);
    history.replaceState({}, '', '/app?influence360RefId=clk-777');
    tracker.init('site-1');
    tracker.identify('0xConnectedWallet', { chain: 'ETHEREUM' });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0] as [string, Blob];
    expect(url).toBe(
      'https://collect.example/public/pixel/identify?publicToken=site-1',
    );

    const body = JSON.parse(await blobText(blob)) as IdentifyEvent;
    expect(body).not.toHaveProperty('publicToken');
    expect(body.refId).toBe('clk-777');
    expect(body.wallet).toBe('0xConnectedWallet');
    expect(body.chain).toBe('ETHEREUM');

    vi.unstubAllGlobals();
  });

  it('does not send an identify beacon when no ref id was captured', () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon });

    const tracker = new Tracker(COLLECT_URL);
    history.replaceState({}, '', '/app'); // no influence360RefId → nothing to bind
    tracker.init('site-1');
    tracker.identify('0xConnectedWallet');

    expect(sendBeacon).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
