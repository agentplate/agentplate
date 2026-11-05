/**
 * Secret redaction.
 *
 * Best-effort scrubbing of credentials from text before it is logged, stored,
 * or surfaced in mail/audit records. This is defense-in-depth, not a guarantee:
 * the architecture keeps secrets out of these channels in the first place, and
 * this is the backstop.
 */

const REDACTED = "[REDACTED]";

/**
 * Patterns whose ENTIRE match is a secret. The full match is replaced. Ordered
 * most-specific first so a narrower pattern (sk-ant-) wins before a broader one.
 */
const WHOLE_SECRET_PATTERNS: RegExp[] = [
	// PEM private key blocks.
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	// Provider API keys with recognizable prefixes.
	/\bsk-ant-[a-zA-Z0-9_-]{16,}\b/g,
	// OpenAI project / service-account / admin keys and OpenRouter keys: a
	// dashed sub-prefix, so the plain `sk-` rule below would stop at the dash.
	/\bsk-(?:proj|svcacct|admin|or-v1)-[A-Za-z0-9_-]{20,}/g,
	/\bsk-[a-zA-Z0-9]{20,}\b/g,
	// GitHub fine-grained PATs, then classic PAT / OAuth / user / server / refresh tokens.
	/\bgithub_pat_[A-Za-z0-9_]{22,}/g,
	/\bgh[pousr]_[a-zA-Z0-9]{20,}\b/g,
	// AWS access key ids: long-term (AKIA) and STS temporary (ASIA).
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	// Google API keys (e.g. GEMINI_API_KEY).
	/\bAIza[0-9A-Za-z_-]{35,}/g,
];

/**
 * Patterns where capture group 1 is a prefix to KEEP and the rest is the secret
 * to redact (so logs stay readable: `ANTHROPIC_API_KEY=[REDACTED]`).
 */
const PREFIXED_SECRET_PATTERNS: RegExp[] = [
	// Bearer tokens in Authorization headers — raw (`Authorization: Bearer …`) or
	// as a JSON field (`"authorization":"Bearer …"`, `\"Authorization\": \"Bearer …`
	// inside an already-JSON-encoded string).
	/\b(Authorization\\?["']?\s*:\s*\\?["']?Bearer\s+)[^\s"'\\]+/gi,
	// JSON fields named like an env-var secret: `"GHCR_TOKEN": "…"` (or the escaped
	// `\"GHCR_TOKEN\": \"…\"`). Deliberately case-SENSITIVE and limited to quoted
	// string values so it adds no new over-redaction of ordinary code (`"maxTokens":
	// 4096`, `"primaryKey": true`); the closing quote is kept, so JSON stays valid.
	/(\\?"[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\\?"\s*:\s*\\?")[^"\\\n]+/g,
	// `KEY=value` / `TOKEN: value` / `SECRET="value"` assignments.
	/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']+["']?/gi,
];

/**
 * Return `text` with recognized secrets redacted. Whole-secret matches are
 * replaced entirely; prefixed matches keep their key and redact the value.
 */
export function sanitize(text: string): string {
	let result = text;
	for (const pattern of WHOLE_SECRET_PATTERNS) {
		result = result.replace(pattern, REDACTED);
	}
	for (const pattern of PREFIXED_SECRET_PATTERNS) {
		result = result.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
	}
	return result;
}

/** True if the text appears to contain a secret (after-the-fact safety check). */
export function containsSecret(text: string): boolean {
	return sanitize(text) !== text;
}
