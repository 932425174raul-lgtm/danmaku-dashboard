import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
          clearMocks: true,
          restoreMocks: true,
          mockReset: true,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          clearMocks: true,
          restoreMocks: true,
          mockReset: true,
        },
      },
    ],
  },
})
