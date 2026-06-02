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
 * Matches a fenced code block whose info string is `bash` or `sh` (optionally
 * with trailing words, e.g. ```` ```bash title=x ````). Capture group 1 is the
 * block's interior. The `m` flag lets the fences sit on their own lines and `g`
 * walks every block in the body.
 */
const BASH_FENCE_RE = /```(?:bash|sh)\b[^\n]*\n([\s\S]*?)```/gim;

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
 * Extract the interiors of every ```bash / ```sh fenced code block in `body`.
 *
 * Returns one string per matched block (fences stripped, interior preserved).
 * If the body contains no fenced bash/sh blocks the array is empty — callers
 * fall back to scanning the whole body so an unfenced snippet is not missed.
 */
export function extractBashBlocks(body: string): string[] {
	const blocks: string[] = [];
	// A fresh lastIndex per call: the regex is module-level and stateful with /g.
	BASH_FENCE_RE.lastIndex = 0;
	for (let m = BASH_FENCE_RE.exec(body); m !== null; m = BASH_FENCE_RE.exec(body)) {
		const interior = m[1];
		if (interior !== undefined) blocks.push(interior);
	}
	return blocks;
}

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
 *  3. Scan the body's ```bash/```sh blocks (falling back to the whole body) for
 *     dangerous commands — each hit is a FATAL `dangerous command: <hit>`
 *     violation. A deploy verb anywhere in the body is a FATAL
 *     `deploy verb in skill (reserved for deployer)` violation.
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

	// Steps 3-4 operate on the body. Track dangerous/deploy hits separately from
	// the (non-fatal) redaction/rewrite violations so `ok` reflects only fatals.
	let dangerous = false;
	let deploy = false;

	if (body !== undefined) {
		// Step 3a: scan fenced bash/sh blocks; fall back to the whole body when the
		// snippet was left unfenced so a raw `rm -rf /` is still caught.
		const blocks = extractBashBlocks(body);
		const scanTargets = blocks.length > 0 ? blocks : [body];
		const seenHits = new Set<string>();
		for (const target of scanTargets) {
			for (const hit of findDangerousCommands(target)) {
				dangerous = true;
				// De-duplicate identical hits (same command in body + a block) so the
				// violation list stays signal-dense.
				if (!seenHits.has(hit)) {
					seenHits.add(hit);
					violations.push(`dangerous command: ${hit}`);
				}
			}
		}

		// Step 3b: deploy verbs are checked against the entire body (they may sit in
		// prose, not just a code fence) and are reserved for the gated deployer.
		if (hasDeployVerb(body)) {
			deploy = true;
			violations.push("deploy verb in skill (reserved for deployer)");
		}

		// Step 4: rewrite operator home-directory paths to a neutral placeholder.
		body = rewriteHomePaths(body, violations);
	}

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
