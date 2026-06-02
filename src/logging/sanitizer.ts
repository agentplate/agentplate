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
	/\bsk-[a-zA-Z0-9]{20,}\b/g,
	/\bghp_[a-zA-Z0-9]{20,}\b/g,
	/\bgho_[a-zA-Z0-9]{20,}\b/g,
	// AWS access key ids.
	/\bAKIA[0-9A-Z]{16}\b/g,
];

/**
 * Patterns where capture group 1 is a prefix to KEEP and the rest is the secret
 * to redact (so logs stay readable: `ANTHROPIC_API_KEY=[REDACTED]`).
 */
const PREFIXED_SECRET_PATTERNS: RegExp[] = [
	// Bearer tokens in Authorization headers.
	/\b(Authorization:\s*Bearer\s+)[^\s"']+/gi,
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
