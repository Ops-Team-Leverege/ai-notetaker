import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts', '../tests/unit/bot/**/*.test.ts', '../tests/property/bot/**/*.property.ts'],
    },
});
