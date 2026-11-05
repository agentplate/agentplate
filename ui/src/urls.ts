// URL + auth-token helpers for the API client. Pure functions (no DOM access at
// import time) so they can be unit-tested under `bun test`.
//
// Sub-path mounts: the SPA is built with `base: "./"`, so assets resolve against
// the page URL. API + WS URLs must do the same — a root-absolute "/api/…" would
// escape a reverse-proxy prefix like https://host/agentplate/. Every endpoint is
// therefore an app-relative path resolved against `document.baseURI`.

/** sessionStorage key holding the bearer token for a non-loopback `agentplate serve`. */
export const TOKEN_STORAGE_KEY = "agentplate.token";

/** Resolve an app-relative path ("api/overview") against the document base URL. */
export function resolveUrl(path: string, base: string): string {
	return new URL(path.replace(/^\/+/, ""), base).toString();
}

/** The ws:// / wss:// URL for an app-relative path, following the base's scheme. */
export function resolveWsUrl(path: string, base: string, token: string | null): string {
	const u = new URL(resolveUrl(path, base));
	u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
	// Browsers can't set headers on a WS handshake, so the token rides as a query param.
	if (token) u.searchParams.set("token", token);
	return u.toString();
}

/** Minimal storage surface (sessionStorage, or a stand-in in tests). */
export interface TokenStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * Pick up the token handed over in the page URL (`?token=…`, printed by
 * `agentplate serve` for non-loopback binds) and persist it for this tab.
 * Returns the token (from the URL, else from storage) and, when the URL carried
 * one, that URL with the token stripped — so it doesn't linger in history,
 * bookmarks or a Referer header.
 */
export function captureToken(
	href: string,
	store: TokenStore | null,
): { token: string | null; cleanHref: string | null } {
	const u = new URL(href);
	const fromUrl = u.searchParams.get("token");
	if (fromUrl) {
		try {
			store?.setItem(TOKEN_STORAGE_KEY, fromUrl);
		} catch {
			// Storage disabled (private mode etc.): the token still works for this page load.
		}
		u.searchParams.delete("token");
		return { token: fromUrl, cleanHref: u.toString() };
	}
	let stored: string | null = null;
	try {
		stored = store?.getItem(TOKEN_STORAGE_KEY) ?? null;
	} catch {
		stored = null;
	}
	return { token: stored, cleanHref: null };
}

/** Request headers for an API call, adding `Authorization` when a token is held. */
export function authHeaders(
	token: string | null,
	extra: Record<string, string> = {},
): Record<string, string> {
	return token ? { ...extra, authorization: `Bearer ${token}` } : { ...extra };
}
