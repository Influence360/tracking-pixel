// Node 24+ defines a global `localStorage`/`sessionStorage` accessor (experimental Web Storage) that returns
// `undefined` unless the process is started with `--localstorage-file`. vitest's jsdom environment uses the Node
// global object as `window` (window === globalThis), so that broken accessor shadows jsdom's real Storage and
// `window.localStorage` reads back `undefined` — silently disabling the pixel's localStorage attribution fallback.
//
// Fix: install a *real* jsdom `Storage` (borrowed from a throwaway window) over whatever the environment left
// behind. Deliberately unconditional — no Node-version or truthiness sniffing — so the storage under test has the
// same implementation on every Node version, instead of jsdom's on ≤23 and a substitute on 24+. Then probe it, so
// a future environment change surfaces as a loud setup failure rather than as tests quietly exercising nothing.
//
// Safe to delete once Node stops shadowing jsdom's Storage (or vitest's jsdom env reinstalls it) — drop this file
// and `setupFiles` in vitest.config.ts, and the tests must still pass.

import { JSDOM } from 'jsdom';

// Same origin as the vitest jsdom environment (see vitest.config.ts): Storage requires a non-opaque origin.
// Module-level so the donor window is never garbage-collected out from under the borrowed Storage objects.
const donor = new JSDOM('', { url: 'https://shop.example/' }).window;

for (const key of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, key, {
    value: donor[key],
    configurable: true,
    writable: true,
  });

  const storage: Storage = globalThis[key];
  const probe = '__influence360_storage_probe';
  storage.setItem(probe, 'ok');
  if (storage.getItem(probe) !== 'ok') {
    throw new Error(
      `test setup: window.${key} does not round-trip a value — the pixel's storage fallback cannot be tested`,
    );
  }
  storage.removeItem(probe);
}
