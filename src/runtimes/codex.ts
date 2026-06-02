/**
 * OpenAI Codex runtime adapter.
 *
 * Drives OpenAI's `codex` CLI in headless, spawn-per-turn mode. Like Claude Code,
 * Codex authenticates with its OWN login: a ChatGPT/Codex OAuth session stored in
 * `~/.codex/auth.json` (`auth_mode` + `tokens`). When the active provider uses
 * `authMode: "subscription"`, the provider layer injects no key (see
 * `src/runtimes/resolve.ts`) and Codex falls back to that OAuth login — the exact
 * mirror of how the Anthropic provider reuses the `claude` login. An
 * `api-key` / `env` provider instead flows `OPENAI_API_KEY` through
 * {@link CodexRuntime.buildEnv}; auth is never hardcoded here.
 *
 * A headless turn is `codex exec --json …`, whose stdout is a stream of JSONL
 * thread/item events (`thread.started`, `item.completed`, `turn.completed`);
 * {@link CodexRuntime.parseEvents} normalizes those into {@link AgentEvent}s.
 * Session continuity across turns is carried by the `thread_id` captured from the
 * `thread.started` event and threaded back via `codex exec resume <id>`
 * ({@link DirectSpawnOpts.resumeSessionId}).
 *
 * Validated against codex-cli 0.128 flag + JSON-event shapes.
 */

import type { ResolvedModel } from "../types.ts";
import type { AgentEvent, AgentRuntime, DirectSpawnOpts, InteractiveSpawnOpts } from "./types.ts";

export class CodexRuntime implements AgentRuntime {
	/** Registry id; also the value users pass to `--runtime codex`. */
	readonly id = "codex";

	/** Beta: validated against codex-cli 0.128 flag shapes. */
	readonly stability = "beta" as const;

	/** Codex reads `AGENTS.md` from the working directory at startup. */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Build argv for one headless streaming turn (`codex exec --json`).
	 *
	 * Flag choices:
	 * - `exec` runs Codex non-interactively and exits on completion.
	 * - `--json` emits the per-event EventMsg JSONL that {@link parseEvents}
	 *   consumes (including the `session_configured` event carrying the session id).
	 * - `--model <model>` pins the concrete model resolved upstream.
	 * - `--dangerously-bypass-approvals-and-sandbox` is the analog of Claude Code's
	 *   `bypassPermissions`: workers run unattended in an isolated worktree, so
	 *   interactive approval prompts would deadlock a headless process.
	 * - `resume <id>` (a subcommand) is emitted ONLY on follow-up turns; the first
	 *   turn omits it so Codex starts a fresh session.
	 *
	 * The prompt is the trailing positional. Returned as an argv array (never a
	 * shell string) so no value is subject to shell interpolation.
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		const prompt = opts.prompt ?? "";
		// Only resume when a prior turn handed us a real session id. An empty string
		// is treated as "no resume" so the first turn opens a new session.
		if (opts.resumeSessionId) {
			return [
				"codex",
				"exec",
				"resume",
				opts.resumeSessionId,
				"--json",
				"--model",
				opts.model,
				"--dangerously-bypass-approvals-and-sandbox",
				prompt,
			];
		}
		return [
			"codex",
			"exec",
			"--json",
			"--model",
			opts.model,
			"--dangerously-bypass-approvals-and-sandbox",
			prompt,
		];
	}

	/**
	 * Build argv for an ATTENDED interactive Codex session.
	 *
	 * Run in the foreground with inherited stdio so the operator chats directly
	 * (`coordinator start`). Codex has no `--append-system-prompt` flag, so the
	 * agent's role must be supplied via the `AGENTS.md` overlay; `systemPrompt`/
	 * `permissionMode` are accepted for interface parity but not passed as flags
	 * (the human is present to approve actions, so the default posture applies). A
	 * seed message becomes the initial prompt while the TUI stays interactive.
	 */
	buildInteractiveSpawn(opts: InteractiveSpawnOpts): string[] {
		const argv = ["codex", "--model", opts.model];
		if (opts.initialMessage && opts.initialMessage.length > 0) {
			argv.push(opts.initialMessage);
		}
		return argv;
	}

	/**
	 * Provider env vars for the resolved model (API keys, base URLs).
	 *
	 * Auth is never hardcoded here — it is whatever the provider layer resolved
	 * onto the model (empty for subscription/OAuth login, `OPENAI_API_KEY` for an
	 * api-key/env provider). A fresh object is returned so a caller mutating the
	 * result cannot leak back into shared config.
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return { ...(model.env ?? {}) };
	}

	/**
	 * Build argv for a one-shot, non-streaming call (`codex exec`). Used by
	 * AI-assisted merge resolution and skill distillation, where we want only the
	 * final text answer, not an event stream. The bypass flag keeps it
	 * non-interactive; the model is appended only when provided so the caller can
	 * defer to Codex's own default.
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const argv = ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"];
		if (model !== undefined) {
			argv.push("--model", model);
		}
		argv.push(prompt);
		return argv;
	}

	/**
	 * Parse Codex's `--json` stdout into normalized {@link AgentEvent}s.
	 *
	 * The stream is JSONL: one JSON object per line, but pipe chunk boundaries do
	 * NOT align to newlines, so we keep a `buffer` of the trailing partial line
	 * across reads and only parse once a `\n` completes it. Malformed lines are
	 * skipped (a partial flush or diagnostic line must not abort the whole turn).
	 */
	async *parseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const event = parseCodexLine(line);
					if (event) yield event;
				}
			}

			const tail = parseCodexLine(buffer);
			if (tail) yield tail;
		} finally {
			reader.releaseLock();
		}
	}
}

/**
 * Parse a single `codex exec --json` line into an {@link AgentEvent}, or `null`
 * for a blank or unparseable line.
 *
 * codex-cli 0.128 emits the thread/item schema, flat per line:
 *   - `{ type: "thread.started", thread_id }`        ← the resume session id
 *   - `{ type: "turn.started" | "turn.completed", usage? }`
 *   - `{ type: "item.completed", item: { type, … } }` ← messages / tool actions
 * We also tolerate the older EventMsg form (`{ id, msg: { type, … } }`) so the
 * parser works across codex versions — mirroring the Claude parser's resilience.
 */
function parseCodexLine(line: string): AgentEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (typeof raw !== "object" || raw === null) return null;
	const top = raw as Record<string, unknown>;

	// Thread/item form is flat; the legacy EventMsg form nests under `msg`.
	const msg =
		typeof top.msg === "object" && top.msg !== null ? (top.msg as Record<string, unknown>) : top;

	const type =
		typeof top.type === "string" ? top.type : typeof msg.type === "string" ? msg.type : "unknown";

	const event: AgentEvent = { type, raw };

	const sessionId = extractCodexSessionId(msg, top);
	if (sessionId !== undefined) event.sessionId = sessionId;

	const tool = extractCodexTool(top, msg);
	if (tool !== undefined) event.tool = tool;

	const usage = extractCodexUsage(top);
	if (usage !== undefined) event.usage = usage;

	return event;
}

/**
 * Pull the resume session id from a Codex event: `thread_id` on `thread.started`
 * (0.128), or `session_id` on the legacy `session_configured` event. A top-level
 * `session_id` is also accepted so resume keeps working across codex versions.
 */
function extractCodexSessionId(
	msg: Record<string, unknown>,
	top: Record<string, unknown>,
): string | undefined {
	for (const candidate of [top.thread_id, msg.session_id, top.session_id]) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

/**
 * Derive a coarse tool name from a Codex event. In the thread/item schema, tool
 * activity is an `item` whose `type` is something other than `agent_message` /
 * `reasoning` (e.g. `command_execution`, `mcp_tool_call`, `file_change`,
 * `web_search`). Legacy EventMsg shapes use `exec_command_begin` /
 * `mcp_tool_call_begin`. Returns `undefined` when no tool is involved.
 */
function extractCodexTool(
	top: Record<string, unknown>,
	msg: Record<string, unknown>,
): string | undefined {
	const item = top.item;
	if (typeof item === "object" && item !== null) {
		const it = item as Record<string, unknown>;
		const itype = typeof it.type === "string" ? it.type : undefined;
		if (itype && itype !== "agent_message" && itype !== "reasoning") {
			if (itype === "mcp_tool_call" && typeof it.tool === "string") return it.tool;
			if (itype === "command_execution") return "shell";
			return itype;
		}
	}

	if (msg.type === "exec_command_begin") return "shell";
	if (msg.type === "mcp_tool_call_begin") {
		if (typeof msg.tool === "string") return msg.tool;
		const invocation = msg.invocation;
		if (typeof invocation === "object" && invocation !== null) {
			const tool = (invocation as Record<string, unknown>).tool;
			if (typeof tool === "string") return tool;
		}
		return "mcp";
	}
	return undefined;
}

/**
 * Pull token usage from a Codex `turn.completed` event's `usage` object. Codex
 * reports token counts but not a USD figure, so `costUsd` is 0. Tokens are
 * `input_tokens + output_tokens` (cached/reasoning counts are subsets of those,
 * so they are not added again). Returns `undefined` when no usage is present.
 */
function extractCodexUsage(
	top: Record<string, unknown>,
): { tokens: number; costUsd: number } | undefined {
	if (top.type !== "turn.completed") return undefined;
	const usage = top.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as Record<string, unknown>;
	const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
	const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
	const tokens = input + output;
	if (tokens === 0) return undefined;
	return { tokens, costUsd: 0 };
}

/** Singleton for callers that do not need dependency injection. */
export const codexRuntime = new CodexRuntime();
