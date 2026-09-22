import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'homebridge-ui/**/*.test.ts'],
    fileParallelism: false,
  },
});
