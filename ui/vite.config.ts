import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA is served by `agentplate serve` from ui/dist, possibly under an arbitrary
// mount path, so all asset URLs must be relative ("./"). In dev, Vite serves the
// app directly and proxies /api + /ws to a locally running `agentplate serve`
// (default port 7551) so the live dashboard works without CORS or a separate
// terminal juggling ports.
const SERVE_TARGET = "http://127.0.0.1:7551";

export default defineConfig({
	plugins: [react()],
	base: "./",
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/api": {
				target: SERVE_TARGET,
				changeOrigin: true,
			},
			"/healthz": {
				target: SERVE_TARGET,
				changeOrigin: true,
			},
			"/ws": {
				target: SERVE_TARGET,
				changeOrigin: true,
				ws: true,
			},
		},
	},
});
