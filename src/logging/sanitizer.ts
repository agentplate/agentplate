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
 *
 * Coverage of the provider catalog (src/providers/registry.ts): Anthropic
 * (`sk-ant-`), OpenAI (`sk-proj-`/`sk-svcacct-`/`sk-admin-`/legacy `sk-`),
 * OpenRouter (`sk-or-v1-`), DeepSeek and OpenCode Zen (plain `sk-`), Gemini
 * (`AIza`, plus `ya29.` OAuth tokens from a Gemini CLI login). Ollama and custom
 * endpoints have no fixed key format; their values are caught by the
 * assignment rules below and by {@link sanitize}'s `knownSecrets`.
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
	// Google API keys (e.g. GEMINI_API_KEY) and Google OAuth access tokens.
	/\bAIza[0-9A-Za-z_-]{35,}/g,
	/\bya29\.[0-9A-Za-z_-]{20,}/g,
	// Slack bot / user / app / refresh tokens.
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
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
	// JSON fields named like an env-var secret: `"GHCR_TOKEN": "…"`. Deliberately
	// case-SENSITIVE and limited to quoted string values so it adds no new
	// over-redaction of ordinary code (`"maxTokens": 4096`, `"primaryKey": true`).
	// The value runs to the first UNESCAPED quote (`\"` inside it is part of the
	// secret), and the closing quote is kept, so JSON stays valid.
	/((?<!\\)"[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*"\s*:\s*")(?:\\.|[^"\\\n])+/g,
	// The same field inside an already JSON-encoded string (`\"GHCR_TOKEN\": \"…\"`):
	// the value ends at the next `\"`; an inner escaped quote is encoded as `\\\"`
	// and an inner backslash as `\\\\`, both of which belong to the value.
	/(\\"[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\\"\s*:\s*\\")(?:\\\\\\["\\]|\\\\[^"\\]|[^"\\\n])+/g,
];

/**
 * Assignment-shaped secrets: `NAME = value`, `NAME: value`, `"NAME": "value"`.
 * Group 1 is the name plus separator (kept), group 2 the bare name, group 3 the
 * value (a whole quoted literal or a bare token, never trailing `,;)]}`).
 *
 * - {@link ENV_ASSIGNMENT}: case-SENSITIVE SCREAMING_SNAKE names
 *   (`ANTHROPIC_API_KEY=…`, `export GHCR_TOKEN="…"`). Any literal value is
 *   redacted — env vars are where this project's secrets live.
 * - {@link CODE_ASSIGNMENT}: any-case identifiers that END in key / token /
 *   secret / password (`apiKey`, `client_secret`, `x-api-key`, `password`), so
 *   `tokenizer`, `maxTokens`, `sortKeys`, `keyboard` never match. The value must
 *   additionally LOOK like a secret ({@link looksLikeCodeSecret}), so
 *   `primaryKey: true`, `apiKey: string`, `const apiKey = config.apiKey` and
 *   `sortKey: "createdAt"` are left alone.
 */
const ASSIGNMENT_VALUE = String.raw`("[^"\n]*"|'[^'\n]*'|\x60[^\x60\n]*\x60|[^\s"'\x60]*[^\s"'\x60,;)\]}])`;
const ASSIGNMENT_SEPARATOR = String.raw`["']?\s*(?::=|=>|=(?!=)|:(?![:=]))\s*`;
const ENV_ASSIGNMENT = new RegExp(
	String.raw`(\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)${ASSIGNMENT_SEPARATOR})${ASSIGNMENT_VALUE}`,
	"g",
);
const CODE_ASSIGNMENT = new RegExp(
	String.raw`((?<![A-Za-z0-9$])["']?((?:[A-Za-z_][\w-]*?)?(?:key|token|secret|password|passwd))${ASSIGNMENT_SEPARATOR})${ASSIGNMENT_VALUE}`,
	"gi",
);

/** Strip one pair of matching surrounding quotes, reporting whether there were any. */
function unquote(value: string): { inner: string; quoted: boolean } {
	const first = value[0];
	if (value.length >= 2 && (first === '"' || first === "'" || first === "`")) {
		if (value[value.length - 1] === first) return { inner: value.slice(1, -1), quoted: true };
	}
	return { inner: value, quoted: false };
}

/**
 * Values that are never a literal secret: references to one (`$VAR`, `${VAR}`,
 * `${{ secrets.X }}`, `%VAR%`, `process.env.X`, `os.environ[...]`), template
 * placeholders (`<your-key>`, `{{ key }}`), an already-redacted value, and
 * booleans / null.
 */
function isNonSecretValue(inner: string): boolean {
	if (inner === "" || inner === REDACTED) return true;
	if (/^(?:true|false|null|nil|none|undefined)$/i.test(inner)) return true;
	if (/^(?:\$|%\w+%$|<[^>]*>$|\{\{)/.test(inner)) return true;
	return /^(?:process\.env\b|os\.(?:environ|getenv)\b|import\.meta\.env\b|Bun\.env\b)/.test(inner);
}

/**
 * Does a value assigned to a code-style `…key/token/secret/password` name look
 * like a literal secret (rather than code, a type, a flag or an identifier)?
 *
 * - Code is never a secret: member paths (`config.apiKey`; a JWT's `eyJ…`
 *   segments excepted), calls / indexing / object literals, type names.
 * - Password-named fields hold low-entropy secrets by nature: any quoted
 *   literal counts, and a bare token counts once it is more than a plain word
 *   (`hunter2`, `p@ss`), so `password: string` / `password: hashed` stay.
 * - key / token / secret fields need a high-entropy value: ≥ 12 chars with
 *   both letters and digits, or ≥ 20 chars mixing three character classes.
 */
function looksLikeCodeSecret(name: string, rawValue: string): boolean {
	const { inner, quoted } = unquote(rawValue);
	if (isNonSecretValue(inner)) return false;
	if (!quoted) {
		if (/[()[\]{}]/.test(inner)) return false;
		if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/.test(inner) && !inner.startsWith("eyJ")) {
			return false;
		}
		if (/^[+-]?\d+(?:\.\d+)?$/.test(inner)) return false;
	}
	if (/(?:password|passwd)$/i.test(name)) {
		return quoted || !/^[A-Za-z_]+$/.test(inner);
	}
	if (/\s/.test(inner)) return false;
	const hasLetter = /[A-Za-z]/.test(inner);
	const hasDigit = /\d/.test(inner);
	if (inner.length >= 12 && hasLetter && hasDigit) return true;
	const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(inner)).length;
	return inner.length >= 20 && classes >= 3;
}

/** Replace a value but keep its surrounding quotes so quoted literals stay well-formed. */
function redactValue(rawValue: string): string {
	const { quoted } = unquote(rawValue);
	if (!quoted) return REDACTED;
	const quote = rawValue[0] ?? "";
	return `${quote}${REDACTED}${quote}`;
}

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return `text` with recognized secrets redacted. Whole-secret matches are
 * replaced entirely; prefixed and assignment matches keep their key and redact
 * the value.
 *
 * `knownSecrets` are literal secret values (e.g. the configured provider API
 * keys) to redact wherever they appear, whatever their format. Values shorter
 * than 8 characters are ignored so placeholder keys like `ollama` cannot shred
 * ordinary text.
 */
export function sanitize(text: string, knownSecrets: readonly string[] = []): string {
	let result = text;
	const known = [...new Set(knownSecrets.filter((s) => s.length >= 8))].sort(
		(a, b) => b.length - a.length,
	);
	for (const secret of known) {
		result = result.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
	}
	for (const pattern of WHOLE_SECRET_PATTERNS) {
		result = result.replace(pattern, REDACTED);
	}
	for (const pattern of PREFIXED_SECRET_PATTERNS) {
		result = result.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
	}
	result = result.replace(ENV_ASSIGNMENT, (match, prefix: string, name: string, value: string) => {
		const { inner } = unquote(value);
		if (isNonSecretValue(inner)) return match;
		// `MAX_TOKENS=4096` / `NUM_KEYS: 3` are counts, not credentials.
		if (/(?:KEYS|TOKENS|SECRETS)(?:_|$)/.test(name) && /^\d+$/.test(inner)) return match;
		return `${prefix}${redactValue(value)}`;
	});
	result = result.replace(CODE_ASSIGNMENT, (match, prefix: string, name: string, value: string) =>
		looksLikeCodeSecret(name, value) ? `${prefix}${redactValue(value)}` : match,
	);
	return result;
}

/** True if the text appears to contain a secret (after-the-fact safety check). */
export function containsSecret(text: string, knownSecrets: readonly string[] = []): boolean {
	return sanitize(text, knownSecrets) !== text;
}
