/**
 * Claude Code runtime adapter.
 *
 * Drives Anthropic's `claude` CLI in headless, spawn-per-turn mode. Each turn is
 * a single `claude -p … --output-format stream-json` invocation whose stdout is a
 * stream of NDJSON events; {@link ClaudeRuntime.parseEvents} normalizes those into
 * {@link AgentEvent}s. The adapter is stateless — session continuity across turns
 * is carried entirely by the runtime session id (`--resume`), which the caller
 * extracts from the `sessionId` an event reports and threads back in via
 * {@link DirectSpawnOpts.resumeSessionId}.
 */

import type { ResolvedModel } from "../types.ts";
import type { AgentEvent, AgentRuntime, DirectSpawnOpts, InteractiveSpawnOpts } from "./types.ts";

/**
 * Claude Code's own sub-agent / orchestration tools, disabled on every
 * Agentplate-driven session. Agents MUST spawn teammates only through
 * `agentplate sling` (via Bash) so the work is tracked in the session store, mail
 * bus, and merge queue. Subagents launched with Claude Code's native tools are
 * invisible to all of that — they never show in `ap serve`/`ap tui` and their
 * work is never merged. Blocking the tools makes sling the ONLY spawn path
 * (Bash/Read/Edit/Write etc. remain available, so sling still works). Unknown
 * names are harmless — Claude Code just ignores tools it doesn't have.
 */
const BLOCKED_SPAWN_TOOLS = ["Task", "Agent", "Workflow"] as const;

/**
 * Additional tools disabled for the INTERACTIVE coordinator only. The coordinator
 * is a dispatcher, not an implementer — it must hire agents via `agentplate sling`
 * (Bash) and never edit code itself. Blocking the file-mutation tools enforces
 * that at the tool layer (Bash/Read/Grep/Glob stay, so sling + surveying work).
 * Headless worker turns ({@link ClaudeRuntime.buildDirectSpawn}) do NOT get this —
 * workers must edit.
 */
const COORDINATOR_BLOCKED_TOOLS = [
	...BLOCKED_SPAWN_TOOLS,
	"Edit",
	"Write",
	"MultiEdit",
	"NotebookEdit",
] as const;

export class ClaudeRuntime implements AgentRuntime {
	/** Registry id; also the value users pass to `--runtime claude`. */
	readonly id = "claude";

	/** Claude Code is the primary, fully-supported runtime. */
	readonly stability = "stable" as const;

	/**
	 * Claude Code automatically reads `.claude/CLAUDE.md` from the working
	 * directory, so the overlay is written there rather than passed as a flag.
	 */
	readonly instructionPath = ".claude/CLAUDE.md";

	/**
	 * Build argv for one headless streaming turn (run via `Bun.spawn`).
	 *
	 * Flag choices:
	 * - `-p <prompt>` runs the prompt non-interactively and exits on completion.
	 *   The prompt defaults to "" so a resume-only nudge turn (where the caller
	 *   feeds the real text on stdin) still produces a well-formed argv.
	 * - `--output-format stream-json` + `--verbose` emit the per-event NDJSON that
	 *   {@link parseEvents} consumes; `--verbose` is required for the streaming
	 *   form to include tool-use / session events rather than a single result.
	 * - `--model <model>` pins the concrete model resolved upstream.
	 * - `--resume <id>` is emitted ONLY on follow-up turns (a non-empty session
	 *   id). The first turn omits it so Claude Code starts a fresh session.
	 * - `--permission-mode bypassPermissions` because workers run unattended in an
	 *   isolated worktree; interactive permission prompts would deadlock a
	 *   headless process.
	 *
	 * Returned as an argv array (never a shell string) so no value is subject to
	 * shell interpolation.
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		return [
			"claude",
			"-p",
			opts.prompt ?? "",
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			opts.model,
			// Only resume when a prior turn handed us a real session id. An empty
			// string is treated as "no resume" so the first turn opens a new session.
			...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
			// Force sling-only spawning. The variadic `--disallowedTools <tools...>` is
			// placed before `--permission-mode` so that flag terminates the list and the
			// `-p` prompt (a leading flag value) is never swallowed.
			"--disallowedTools",
			...BLOCKED_SPAWN_TOOLS,
			"--permission-mode",
			"bypassPermissions",
		];
	}

	/**
	 * Build argv for an ATTENDED interactive Claude Code session.
	 *
	 * Run in the foreground with inherited stdio so the operator chats directly
	 * (`coordinator start`). The interactive session IS the coordinator, so it is
	 * dispatch-only: {@link COORDINATOR_BLOCKED_TOOLS} disables the native sub-agent
	 * tools AND file-mutation tools, leaving Bash (for `agentplate sling`) + Read.
	 * The agent's role is injected via `--append-system-prompt` — a literal argv
	 * value (no `$(cat …)` shell trick) since we spawn an argv array.
	 */
	buildInteractiveSpawn(opts: InteractiveSpawnOpts): string[] {
		const permMode = opts.permissionMode === "bypass" ? "bypassPermissions" : "default";
		// `--disallowedTools` (variadic) sits before `--permission-mode` so that flag
		// terminates the tool list and the trailing seed message is never swallowed.
		const argv = [
			"claude",
			"--model",
			opts.model,
			"--disallowedTools",
			...COORDINATOR_BLOCKED_TOOLS,
			"--permission-mode",
			permMode,
		];
		if (opts.systemPrompt && opts.systemPrompt.length > 0) {
			argv.push("--append-system-prompt", opts.systemPrompt);
		}
		// A seed message becomes the first user turn (claude treats a trailing
		// positional as the initial prompt while staying interactive).
		if (opts.initialMessage && opts.initialMessage.length > 0) {
			argv.push(opts.initialMessage);
		}
		return argv;
	}

	/**
	 * Provider env vars for the resolved model (API keys, base URLs).
	 *
	 * Auth is never hardcoded here — it is whatever the provider layer resolved
	 * onto the model. A fresh object is returned (rather than `model.env` itself)
	 * so a caller mutating the result cannot leak back into shared config.
	 *
	 * When the model carries a `baseUrl` (local/gateway provider), it is mapped to
	 * `ANTHROPIC_BASE_URL` (normalized — the CLI appends `/v1/messages` itself).
	 * Only for an explicitly keyless provider (`authMode === "none"`, e.g. a local
	 * Ollama server) a dummy `ANTHROPIC_AUTH_TOKEN` is injected — local servers
	 * ignore the bearer, but the CLI refuses to start without one —
	 * `ANTHROPIC_SMALL_FAST_MODEL` is pinned to the resolved model (Claude's
	 * haiku-class background model does not exist on local servers), and
	 * `ANTHROPIC_API_KEY` is set to "" because the caller spawns with
	 * `{...process.env, ...thisEnv}`: without the explicit empty override, a
	 * shell-exported real key would survive the merge and be sent to the local
	 * endpoint. Any other authMode (api-key/env carry the real key in
	 * `model.env`; subscription keeps the CLI's own login) gets ONLY the base
	 * URL. Without a `baseUrl` the behavior is unchanged.
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		const env: Record<string, string> = { ...(model.env ?? {}) };
		if (model.baseUrl !== undefined) {
			env.ANTHROPIC_BASE_URL = normalizeAnthropicBaseUrl(model.baseUrl);
			if (model.authMode === "none") {
				env.ANTHROPIC_AUTH_TOKEN = "agentplate-local";
				env.ANTHROPIC_SMALL_FAST_MODEL = model.model;
				env.ANTHROPIC_API_KEY = "";
			}
		}
		return env;
	}

	/**
	 * Build argv for a one-shot, non-streaming call (`claude -p … --output-format
	 * text`). Used later by AI-assisted merge resolution and skill distillation,
	 * where we want only the final text answer, not an event stream. The model is
	 * appended only when provided so the caller can defer to Claude Code's own
	 * default.
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const argv = ["claude", "-p", prompt, "--output-format", "text"];
		if (model !== undefined) {
			argv.push("--model", model);
		}
		return argv;
	}

	/**
	 * Parse Claude Code's stream-json stdout into normalized {@link AgentEvent}s.
	 *
	 * The stream is NDJSON: one JSON object per line, but TCP/pipe chunk
	 * boundaries do NOT align to newlines, so we keep a `buffer` of the trailing
	 * partial line across reads and only parse once a `\n` completes it. For each
	 * complete, non-blank line we:
	 *   - parse JSON (silently skipping malformed lines — a partial flush or a
	 *     non-JSON diagnostic line must not abort the whole turn),
	 *   - copy through the message `type`,
	 *   - capture `session_id` → `sessionId` (Claude emits it on the early
	 *     `system` init event; the caller needs it for the next turn's --resume),
	 *   - lift a tool name out of an assistant `tool_use` content block → `tool`,
	 *   - attach the raw parsed object as `raw` for callers needing more detail.
	 */
	async *parseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				// `stream: true` lets the decoder hold back a trailing partial
				// multi-byte sequence until the next chunk completes it.
				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split("\n");
				// The last element is an incomplete line (no terminating newline yet)
				// or "" — keep it buffered for the next read.
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const event = parseClaudeLine(line);
					if (event) yield event;
				}
			}

			// Emit any final line left after a clean stream end without a trailing
			// newline (e.g. the process exits right after writing the result event).
			const tail = parseClaudeLine(buffer);
			if (tail) yield tail;
		} finally {
			// Always release the lock so the underlying stream can be GC'd / reused
			// even if the consumer breaks out of the loop early.
			reader.releaseLock();
		}
	}
}

/**
 * Normalize a provider base URL for `ANTHROPIC_BASE_URL`.
 *
 * The claude CLI (via the Anthropic SDK) appends `/v1/messages` to the base URL
 * itself, but legacy/OpenAI-style configs often store the endpoint with a `/v1`
 * suffix (e.g. `http://localhost:11434/v1`). Strips exactly ONE trailing `/v1`
 * or `/v1/`; anything else (including `/v1beta`) passes through untouched.
 */
export function normalizeAnthropicBaseUrl(url: string): string {
	return url.replace(/\/v1\/?$/, "");
}

/**
 * Parse a single stream-json line into an {@link AgentEvent}, or `null` for a
 * blank or unparseable line. Kept as a free function (not a closure) so it is
 * trivially unit-testable and allocation-free per line.
 */
function parseClaudeLine(line: string): AgentEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		// Not valid JSON (partial flush, diagnostic noise) — skip, never throw.
		return null;
	}

	if (typeof raw !== "object" || raw === null) return null;
	const msg = raw as Record<string, unknown>;

	const event: AgentEvent = {
		type: typeof msg.type === "string" ? msg.type : "unknown",
		raw,
	};

	// session_id appears on the init/system event and is reused for --resume.
	if (typeof msg.session_id === "string" && msg.session_id.length > 0) {
		event.sessionId = msg.session_id;
	}

	const tool = extractToolName(msg);
	if (tool !== undefined) event.tool = tool;

	const usage = extractUsage(msg);
	if (usage !== undefined) event.usage = usage;

	// Surface a failure reason: a `result` event with `is_error` carries the
	// message in `result`; a bare `error` event carries it in `error`/`message`.
	if (msg.is_error === true && typeof msg.result === "string") {
		event.error = msg.result;
	} else if (msg.type === "error") {
		if (typeof msg.error === "string") event.error = msg.error;
		else if (typeof msg.message === "string") event.error = msg.message;
	}

	return event;
}

/**
 * Pull token usage + USD cost out of a Claude Code `result` event, which carries
 * `total_cost_usd` and a `usage` object (`input_tokens`, `output_tokens`, and the
 * two cache token counts). We sum all numeric token fields so cache reads/writes
 * are counted too. Returns `undefined` for non-result events or when no spend was
 * reported, so the Costs page only aggregates real usage.
 */
function extractUsage(
	msg: Record<string, unknown>,
): { tokens: number; costUsd: number } | undefined {
	if (msg.type !== "result") return undefined;

	let tokens = 0;
	const usage = msg.usage;
	if (typeof usage === "object" && usage !== null) {
		for (const key of [
			"input_tokens",
			"output_tokens",
			"cache_creation_input_tokens",
			"cache_read_input_tokens",
		]) {
			const v = (usage as Record<string, unknown>)[key];
			if (typeof v === "number") tokens += v;
		}
	}
	const costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
	if (tokens === 0 && costUsd === 0) return undefined;
	return { tokens, costUsd };
}

/**
 * Pull a tool name out of an assistant message's content blocks. Claude nests
 * tool calls as `{ type: "tool_use", name: "Edit", … }` blocks inside
 * `message.content`; we return the first such name. Returns `undefined` for any
 * shape that does not carry a tool_use block.
 */
function extractToolName(msg: Record<string, unknown>): string | undefined {
	const message = msg.message;
	if (typeof message !== "object" || message === null) return undefined;

	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) return undefined;

	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		if (b.type === "tool_use" && typeof b.name === "string") {
			return b.name;
		}
	}
	return undefined;
}

/** Singleton for callers that do not need dependency injection. */
export const claudeRuntime = new ClaudeRuntime();
