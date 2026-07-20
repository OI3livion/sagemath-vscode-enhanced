import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	// The TypeScript sources live under src/ and compile (rootDir ".") to
	// out/src/... so the compiled tests are at out/src/test/**/*.test.js.
	files: 'out/src/test/**/*.test.js',
});
