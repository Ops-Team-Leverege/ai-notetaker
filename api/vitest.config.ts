import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts', '../tests/unit/api/**/*.test.ts', '../tests/property/api/**/*.property.ts'],
    },
});
