/**
 * Shared guard rules.
 *
 * Single source of truth for "what is a dangerous shell command" and similar
 * safety constants. Used by skill safety scrubbing (Phase 3) and, later, by
 * agent tool guards and deploy guards (Phase 4). Centralized so the definition
 * of "dangerous" never drifts between subsystems.
 */

/**
 * Regexes matching shell commands that must never appear in a distilled skill's
 * snippets (destructive, networked-pipe-to-shell, privilege escalation, or
 * outward-facing mutations that belong only to a gated deployer).
 */
export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
	/\brm\s+-rf?\b/i, // recursive force delete
	/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, // curl … | sh
	/\bsudo\b/i, // privilege escalation
	/\bgit\s+push\b/i, // pushing from inside a skill
	/\bgit\s+reset\s+--hard\b/i, // destructive reset
	/\b(mkfs|dd)\b/i, // disk-level operations
	/\bchmod\s+-R\s+0?777\b/i, // world-writable recursion
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // fork bomb
	/>\s*\/dev\/sd[a-z]/i, // writing to a raw disk
	/\beval\b\s+["'`$]/i, // eval of dynamic input
];

/** Outward-facing deploy/apply verbs (reserved for the gated deployer, Phase 4). */
export const DEPLOY_VERB_PATTERNS: RegExp[] = [
	/\bterraform\s+apply\b/i,
	/\bkubectl\s+apply\b/i,
	/\bhelm\s+(install|upgrade)\b/i,
	/\bdocker\s+push\b/i,
	/\bvercel\b[^\n]*--prod\b/i,
];

/** Does the text contain a dangerous shell command? */
export function hasDangerousCommand(text: string): boolean {
	return DANGEROUS_BASH_PATTERNS.some((re) => re.test(text));
}

/** Return every dangerous pattern that matches (for reporting which line tripped). */
export function findDangerousCommands(text: string): string[] {
	const hits: string[] = [];
	for (const re of DANGEROUS_BASH_PATTERNS) {
		const m = text.match(re);
		if (m) hits.push(m[0]);
	}
	return hits;
}

/** Does the text contain an outward-facing deploy/apply verb? */
export function hasDeployVerb(text: string): boolean {
	return DEPLOY_VERB_PATTERNS.some((re) => re.test(text));
}
