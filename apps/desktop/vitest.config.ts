import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
// testTimeout and hookTimeout: the app's keyboard tests render the whole window, in a hook before each test, and take
// about a second alone, but up to ten on a runner busy with the engine's suite at the same time. The limits catch
// hangs, not slowness, so a hook gets as long as a test.
export default defineConfig({ plugins: [react()], test: { environment: 'happy-dom', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], setupFiles: ['test/setup.ts'], testTimeout: 30_000, hookTimeout: 30_000 } });
