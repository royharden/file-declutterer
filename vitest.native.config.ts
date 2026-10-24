import { defineConfig } from 'vitest/config'

// Explicit disposable-root native harness. Never point it at Downloads or a synced tree.
export default defineConfig({
  test: {
    include: ['tests/native/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
})
