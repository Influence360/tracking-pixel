import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // https origin so `Secure` first-party cookies persist (matches production).
    environmentOptions: {
      jsdom: { url: 'https://shop.example/' },
    },
    // Restores window.localStorage under Node 24+ (see test/setup.ts).
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
