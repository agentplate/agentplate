// Runs under the root `bun test` (pure module, no DOM / UI deps). Excluded from the
// UI tsconfig, whose CI job installs only ui/ deps (no bun types).

import { describe, expect, test } from "bun:test";
import {
	authHeaders,
	captureToken,
	resolveUrl,
	resolveWsUrl,
	TOKEN_STORAGE_KEY,
	type TokenStore,
} from "./urls.ts";

function memoryStore(): TokenStore & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => {
			data.set(k, v);
		},
	};
}

describe("resolveUrl / resolveWsUrl (sub-path mounts)", () => {
	test("root mount resolves to /api/…", () => {
		expect(resolveUrl("api/overview", "http://127.0.0.1:7551/")).toBe(
			"http://127.0.0.1:7551/api/overview",
		);
	});

	test("a reverse-proxy sub-path keeps its prefix for REST and WS", () => {
		const base = "https://host.example/agentplate/";
		expect(resolveUrl("api/agents/builder-1", base)).toBe(
			"https://host.example/agentplate/api/agents/builder-1",
		);
		expect(resolveWsUrl("ws", base, null)).toBe("wss://host.example/agentplate/ws");
	});

	test("a leading slash can't escape the mount; the page query is dropped", () => {
		expect(resolveUrl("/api/overview", "http://h/sub/?token=abc")).toBe(
			"http://h/sub/api/overview",
		);
	});

	test("ws follows the page scheme and carries the token as a query param", () => {
		expect(resolveWsUrl("ws", "http://h:1/", "t k")).toBe("ws://h:1/ws?token=t+k");
		expect(resolveWsUrl("ws", "https://h/", null)).toBe("wss://h/ws");
	});
});

describe("captureToken", () => {
	test("a ?token= in the page URL is stored and stripped from the URL", () => {
		const store = memoryStore();
		const r = captureToken("http://h:1/?token=abc&x=1#frag", store);
		expect(r.token).toBe("abc");
		expect(r.cleanHref).toBe("http://h:1/?x=1#frag");
		expect(store.data.get(TOKEN_STORAGE_KEY)).toBe("abc");
	});

	test("without a URL token the stored one is used (reload keeps working)", () => {
		const store = memoryStore();
		store.setItem(TOKEN_STORAGE_KEY, "kept");
		expect(captureToken("http://h:1/", store)).toEqual({ token: "kept", cleanHref: null });
	});

	test("no token anywhere (loopback) → null; throwing storage is tolerated", () => {
		expect(captureToken("http://127.0.0.1:7551/", memoryStore()).token).toBeNull();
		const broken: TokenStore = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(captureToken("http://h/", broken).token).toBeNull();
		expect(captureToken("http://h/?token=z", broken).token).toBe("z");
	});
});

describe("authHeaders", () => {
	test("adds a Bearer header only when a token is held", () => {
		expect(authHeaders(null, { accept: "application/json" })).toEqual({
			accept: "application/json",
		});
		expect(authHeaders("tok", { accept: "application/json" })).toEqual({
			accept: "application/json",
			authorization: "Bearer tok",
		});
	});
});
