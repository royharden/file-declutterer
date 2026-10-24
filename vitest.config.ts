import { defineConfig } from 'vitest/config'

// Pure core, contracts and sandbox. Legacy tests in tests/*.test.ts target the inactive
// src/engine and are deliberately excluded.
export default defineConfig({
  test: {
    include: ['tests/core/**/*.test.ts', 'tests/sandbox/**/*.test.ts', 'tests/contract/**/*.test.ts'],
    environment: 'node',
  },
})
