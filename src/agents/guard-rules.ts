/**
 * Shared guard rules.
 *
 * Single source of truth for "what is a dangerous shell command" and similar
 * safety constants. Used by skill safety scrubbing (Phase 3) and, later, by
 * agent tool guards and deploy guards (Phase 4). Centralized so the definition
 * of "dangerous" never drifts between subsystems.
 *
 * These are a defense-in-depth denylist, not a sandbox: a regex list can never
 * be complete. Input is normalized first ({@link normalizeCommandText}) so the
 * trivial evasions — invisible Unicode, look-alike compatibility characters,
 * shell quoting / backslashes inside a word, odd spacing — do not slip past.
 */

/** Optional leading git options (`git -C dir`, `git -c a=b`, `git --no-pager`). */
const GIT = String.raw`\bgit(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+`;
/** The rest of one command on the same line (stops at a newline or `;`, `&`, `|`). */
const SAME_CMD = String.raw`[^\n;&|]*`;

/**
 * Regexes matching shell commands that must never appear in a distilled skill's
 * snippets (destructive, networked-pipe-to-shell, privilege escalation, or
 * outward-facing mutations that belong only to a gated deployer). Match them
 * against {@link normalizeCommandText} output, as the helpers below do.
 */
export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
	// Recursive delete in any flag spelling: -rf, -fr, -r -f, -R, --recursive.
	/\brm\s+(?:-\S+\s+)*?(?:-[a-z]*r[a-z]*|--recursive)\b/i,
	// curl/wget … | sh (any common shell or interpreter, optionally via sudo/env).
	/\b(?:curl|wget)\b[^\n|]*\|\s*(?:(?:sudo|doas|env)\s+(?:-\S+\s+|\w+=\S*\s+)*)?(?:ba|z|da|k|fi|c|tc)?sh\b/i,
	/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:python[0-9.]*|perl|ruby|node)\b/i,
	// …or fed to a shell via process / command substitution: bash <(curl …), sh -c "$(curl …)".
	/(?:<\(|\$\()\s*(?:curl|wget)\b/i,
	/\b(?:sudo|doas|pkexec)\b/i, // privilege escalation
	/\bsu\s+-c\b/i,
	new RegExp(`${GIT}push\\b`, "i"), // pushing from inside a skill
	new RegExp(`${GIT}reset\\b${SAME_CMD}\\s--hard\\b`, "i"), // destructive reset
	new RegExp(`${GIT}clean\\b${SAME_CMD}\\s(?:-[a-z]*f|--force)`, "i"), // delete untracked files
	/\bfind\b[^\n;&|]*\s-delete\b/i, // find … -delete
	/\b(mkfs|dd)\b/i, // disk-level operations
	/\bchmod\b[^\n;&|]*(?:\s-[a-z]*R|\s--recursive)\b[^\n;&|]*\b0?777\b/i, // world-writable recursion
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
	/>\s*\/dev\/sd[a-z]/i, // writing to a raw disk
	/\beval\b\s+["'`$]/i, // eval of dynamic input
];

/** Outward-facing deploy/apply/publish verbs (reserved for the gated deployer, Phase 4). */
export const DEPLOY_VERB_PATTERNS: RegExp[] = [
	/\b(?:terraform|tofu)\b[^\n;&|]*\s(?:apply|destroy)\b/i,
	/\bkubectl\b[^\n;&|]*\s(?:apply|replace)\b/i,
	/\bhelm\b[^\n;&|]*\s(?:install|upgrade)\b/i,
	/\bdocker\b[^\n;&|]*\spush\b/i, // docker push, docker image push
	/\bdocker\s+buildx\b[^\n;&|]*\s--push\b/i,
	/\bvercel\b[^\n]*--prod\b/i,
	/\b(?:npm|pnpm|yarn|bun)(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+publish\b/i,
	/\bgh\s+release\s+create\b/i,
	/\b(?:fly|flyctl)\s+deploy\b/i,
];

/**
 * Invisible characters that render as nothing but split a token for a regex:
 * format controls (zero-width space/joiners, bidi overrides, soft hyphen, BOM —
 * all `\p{Cf}`), the combining grapheme joiner, and the Hangul fillers.
 */
const INVISIBLE_CHARS = /\p{Cf}|͏|[ᅟᅠㅤﾠ]/gu;

/**
 * Normalize text before denylist matching, so a command reads the way a shell
 * (or an LLM) would read it:
 *
 *  1. NFKC — fold compatibility look-alikes (fullwidth `ｒｍ`, ligatures) to ASCII.
 *  2. Strip invisible characters (`r​m` → `rm`).
 *  3. Join backslash line continuations, then drop quotes and backslashes,
 *     which the shell removes inside a word (`"rm" -rf`, `r\m`, `'g'it push`).
 *  4. Collapse runs of horizontal whitespace (incl. NBSP / ideographic space)
 *     to one space. Newlines are kept so a match stays within one line.
 */
export function normalizeCommandText(text: string): string {
	return stripInvisible(text)
		.replace(/\\\r?\n/g, " ")
		.replace(/["'`\\]/g, "")
		.replace(/[^\S\n]+/g, " ");
}

/** Steps 1, 2 and 4 of {@link normalizeCommandText} only: quotes are kept. */
function stripInvisible(text: string): string {
	return text
		.normalize("NFKC")
		.replace(INVISIBLE_CHARS, "")
		.replace(/[^\S\n]+/g, " ");
}

/**
 * Both views a pattern is tried against: quotes stripped (so `"rm" -rf` reads
 * as `rm -rf`) and quotes kept (so quote-sensitive rules like `eval "…"` still
 * see them).
 */
function views(text: string): string[] {
	return [normalizeCommandText(text), stripInvisible(text)];
}

/** First match of `re` in any view, or undefined. */
function firstMatch(re: RegExp, forms: string[]): string | undefined {
	for (const form of forms) {
		const m = form.match(re);
		if (m) return m[0];
	}
	return undefined;
}

/** Does the text contain a dangerous shell command? */
export function hasDangerousCommand(text: string): boolean {
	return findDangerousCommands(text).length > 0;
}

/** Return every dangerous pattern that matches (for reporting which line tripped). */
export function findDangerousCommands(text: string): string[] {
	const forms = views(text);
	const hits: string[] = [];
	for (const re of DANGEROUS_BASH_PATTERNS) {
		const hit = firstMatch(re, forms);
		if (hit !== undefined) hits.push(hit);
	}
	return hits;
}

/** Does the text contain an outward-facing deploy/apply verb? */
export function hasDeployVerb(text: string): boolean {
	const forms = views(text);
	return DEPLOY_VERB_PATTERNS.some((re) => firstMatch(re, forms) !== undefined);
}
