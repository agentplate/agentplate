/**
 * Skill safety scrubbing.
 *
 * A distilled {@link SkillDraft} is untrusted text minted by an AI model from a
 * just-completed session: it can leak the operator's secrets, embed destructive
 * shell snippets, name outward-facing deploy verbs that belong only to the gated
 * deployer, or hard-code the operator's home-directory paths. Every draft passes
 * through {@link sanitizeSkillDraft} BEFORE it is ever written to disk.
 *
 * The scrubber is two-tiered:
 *
 * - **Auto-fix (non-fatal):** secrets are redacted in place and home-absolute
 *   paths are rewritten to a neutral `<repo>/...` placeholder. These are recorded
 *   as violations for the audit trail but do NOT fail the report — the cleaned
 *   draft is safe to persist.
 * - **Fatal:** a dangerous shell command or a deploy verb cannot be safely
 *   rewritten, so the report comes back `ok: false`. The caller downgrades the
 *   draft to a `skip` rather than minting a hazardous skill.
 *
 * `skip` drafts (and any non-create/update action) pass straight through: there
 * is nothing to write, so there is nothing to scrub.
 */

import { findDangerousCommands, hasDeployVerb } from "../agents/guard-rules.ts";
import { containsSecret, sanitize } from "../logging/sanitizer.ts";
import type { SkillDraft } from "./types.ts";

/** Outcome of scrubbing a single draft. */
export interface SafetyReport {
	/** True iff the draft is safe to write (no dangerous command, no deploy verb). */
	ok: boolean;
	/** The draft after secret redaction + path rewriting (the copy to persist). */
	redactedDraft: SkillDraft;
	/** Human-readable record of everything the scrubber found or fixed. */
	violations: string[];
}

/**
 * Matches a POSIX home-directory absolute path: `/Users/<name>/...` (macOS) or
 * `/home/<name>/...` (Linux). Capture group 1 is everything AFTER the user's
 * home root, which we graft onto the `<repo>` placeholder. The leading `(?<![\w])`
 * keeps us from rewriting a path that is a substring of a longer token.
 */
const HOME_PATH_RE = /(?<![\w/])\/(?:Users|home)\/[^/\s"'`]+((?:\/[^\s"'`]*)?)/g;

/** Neutral placeholder substituted for an operator's home-directory root. */
const REPO_PLACEHOLDER = "<repo>";

/**
 * Redact a single string field via {@link sanitize}; if {@link containsSecret}
 * flagged it, push a `secret redacted in <field>` violation. Returns the cleaned
 * string (unchanged when nothing matched).
 */
function redactField(
	value: string | undefined,
	field: string,
	violations: string[],
): string | undefined {
	if (value === undefined) return undefined;
	if (containsSecret(value)) {
		violations.push(`secret redacted in ${field}`);
		return sanitize(value);
	}
	return value;
}

/**
 * Redact each element of a string-array field, tracking whether any element held
 * a secret so a single `<field>` violation is recorded for the array as a whole.
 */
function redactArrayField(
	values: string[] | undefined,
	field: string,
	violations: string[],
): string[] | undefined {
	if (values === undefined) return undefined;
	let found = false;
	const cleaned = values.map((value) => {
		if (containsSecret(value)) {
			found = true;
			return sanitize(value);
		}
		return value;
	});
	if (found) violations.push(`secret redacted in ${field}`);
	return cleaned;
}

/**
 * Rewrite home-directory absolute paths in `body` to `<repo>/...`.
 *
 * Records a single `rewrote absolute path` violation if any substitution was
 * made. The trailing capture (everything past the home root) is preserved, so
 * `/Users/alice/Projects/agentplate/src/x.ts` → `<repo>/Projects/agentplate/src/x.ts`.
 */
function rewriteHomePaths(body: string, violations: string[]): string {
	let rewrote = false;
	HOME_PATH_RE.lastIndex = 0;
	const result = body.replace(HOME_PATH_RE, (_match, tail: string) => {
		rewrote = true;
		return `${REPO_PLACEHOLDER}${tail}`;
	});
	if (rewrote) violations.push("rewrote absolute path");
	return result;
}

/**
 * Scrub a skill draft of secrets, dangerous commands, deploy verbs, and
 * home-absolute paths before it is written to disk.
 *
 * Steps (in order):
 *  1. Non-create/update actions (notably `skip`) are inherently safe — return the
 *     draft unchanged with `ok: true`.
 *  2. Redact secrets in `title`, `goal`, `body`, `whenToUse`, and `tags`. A hit
 *     records a non-fatal `secret redacted in <field>` violation but the cleaned
 *     copy proceeds.
 *  3. Scan the whole body (prose and every code fence, whatever its language)
 *     plus `title`, `goal`, each `whenToUse` entry and each tag for dangerous
 *     commands and deploy verbs. A hit is FATAL: `dangerous command: <hit>` /
 *     `deploy verb in skill (reserved for deployer)` for the body, and
 *     `dangerous command in <field>: <hit>` / `deploy verb in <field> (reserved
 *     for deployer)` for the other fields. `filePatterns` are globs, not
 *     instructions, and are not scanned.
 *  4. Rewrite home-absolute paths in the body to `<repo>/...` (non-fatal
 *     `rewrote absolute path`).
 *  5. `ok` is true iff no dangerous-command and no deploy-verb violation fired.
 *     Secret redactions and path rewrites are auto-fixes and never fail the report.
 */
export function sanitizeSkillDraft(draft: SkillDraft): SafetyReport {
	// Step 1: skip (and any non-mutating action) is safe — nothing to write.
	if (draft.action !== "create" && draft.action !== "update") {
		return { ok: true, redactedDraft: draft, violations: [] };
	}

	const violations: string[] = [];

	// Step 2: redact secrets across every free-text field. Arrays are scrubbed
	// element-wise so a leaked key inside one tag/when-to-use entry is caught.
	const title = redactField(draft.title, "title", violations);
	const goal = redactField(draft.goal, "goal", violations);
	const whenToUse = redactArrayField(draft.whenToUse, "whenToUse", violations);
	const tags = redactArrayField(draft.tags, "tags", violations);
	let body = redactField(draft.body, "body", violations);

	// Track dangerous/deploy hits separately from the (non-fatal) redaction and
	// rewrite violations so `ok` reflects only fatals.
	let dangerous = false;
	let deploy = false;

	// Step 3: scan every free-text field. title, goal and body are rendered into
	// agent overlays, whenToUse into the distiller prompt, and tags show up in
	// `skill list` / search. The body is scanned whole: a command in prose, in a
	// ```shell or bare fence, or in a ~~~ fence is as hazardous as one in ```bash.
	const scanTargets: Array<{ field: string; text: string }> = [];
	if (title !== undefined) scanTargets.push({ field: "title", text: title });
	if (goal !== undefined) scanTargets.push({ field: "goal", text: goal });
	for (const text of whenToUse ?? []) scanTargets.push({ field: "whenToUse", text });
	for (const text of tags ?? []) scanTargets.push({ field: "tags", text });
	if (body !== undefined) scanTargets.push({ field: "body", text: body });

	// De-duplicate identical fatal violations (the same command twice in the body,
	// or in two whenToUse entries) so the violation list stays signal-dense.
	const seenFatal = new Set<string>();
	const pushFatal = (violation: string): void => {
		if (seenFatal.has(violation)) return;
		seenFatal.add(violation);
		violations.push(violation);
	};
	for (const { field, text } of scanTargets) {
		const isBody = field === "body";
		for (const hit of findDangerousCommands(text)) {
			dangerous = true;
			pushFatal(isBody ? `dangerous command: ${hit}` : `dangerous command in ${field}: ${hit}`);
		}
		// Deploy verbs are reserved for the gated deployer.
		if (hasDeployVerb(text)) {
			deploy = true;
			pushFatal(`deploy verb in ${isBody ? "skill" : field} (reserved for deployer)`);
		}
	}

	// Step 4: rewrite operator home-directory paths to a neutral placeholder.
	if (body !== undefined) body = rewriteHomePaths(body, violations);

	// Rebuild the draft preserving optional-field semantics: a field that was
	// absent stays absent (no spurious empty keys in the persisted frontmatter).
	const redactedDraft: SkillDraft = { action: draft.action };
	if (draft.targetSlug !== undefined) redactedDraft.targetSlug = draft.targetSlug;
	if (title !== undefined) redactedDraft.title = title;
	if (goal !== undefined) redactedDraft.goal = goal;
	if (whenToUse !== undefined) redactedDraft.whenToUse = whenToUse;
	if (draft.filePatterns !== undefined) redactedDraft.filePatterns = draft.filePatterns;
	if (tags !== undefined) redactedDraft.tags = tags;
	if (body !== undefined) redactedDraft.body = body;

	// Step 5: only fatal categories fail the report.
	const ok = !dangerous && !deploy;
	return { ok, redactedDraft, violations };
}
