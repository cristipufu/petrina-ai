import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
// testTimeout: the app's keyboard tests render the whole window and take about a second alone, but up to ten
// on a CI runner busy with the engine's suite at the same time. The limit catches hangs, not slowness.
export default defineConfig({ plugins: [react()], test: { environment: 'happy-dom', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], setupFiles: ['test/setup.ts'], testTimeout: 30_000 } });
