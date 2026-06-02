/**
 * Cursor runtime adapter (`cursor-agent` CLI).
 *
 * Drives Cursor's `cursor-agent` CLI in headless, spawn-per-turn mode. Like Claude
 * Code, Cursor authenticates with its OWN login: a Cursor OAuth session created by
 * `cursor-agent login` (stored under `~/.cursor`). When the active provider uses
 * `authMode: "subscription"`, the provider layer injects no key (see
 * `src/runtimes/resolve.ts`) and Cursor falls back to that OAuth login — the same
 * pattern the Anthropic provider uses with the `claude` login. An `api-key` / `env`
 * provider instead flows `CURSOR_API_KEY` through {@link CursorRuntime.buildEnv};
 * auth is never hardcoded here.
 *
 * NOTE the id/binary split: the registry id is `cursor` (matching
 * `src/utils/detect.ts`), but the CLI binary is `cursor-agent`.
 *
 * A headless turn is `cursor-agent -p … --output-format stream-json`, whose stdout
 * is a stream of NDJSON events; {@link CursorRuntime.parseEvents} normalizes those
 * into {@link AgentEvent}s. Session continuity across turns is carried by the chat
 * id captured from the event stream and threaded back via `--resume`
 * ({@link DirectSpawnOpts.resumeSessionId}).
 *
 * Validated against cursor-agent 2026.05.28: flags (`-p`, `--output-format
 * stream-json`, `--model`, `--force`, `--resume`), the auth-failure path (surfaced
 * via stderr), and a real authenticated multi-agent run — `system`/`user`/
 * `assistant`/`tool_call`/`result` events parse, with tool names, token usage, and
 * errors extracted.
 */

import type { ResolvedModel } from "../types.ts";
import type { AgentEvent, AgentRuntime, DirectSpawnOpts, InteractiveSpawnOpts } from "./types.ts";

export class CursorRuntime implements AgentRuntime {
	/** Registry id; also the value users pass to `--runtime cursor`. */
	readonly id = "cursor";

	/** Beta: validated against cursor-agent 2026.05.28 (flags + JSON-event shapes). */
	readonly stability = "beta" as const;

	/** Cursor reads `AGENTS.md` from the working directory at startup. */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Build argv for one headless streaming turn (`cursor-agent -p`).
	 *
	 * Flag choices:
	 * - `-p <prompt>` runs the prompt non-interactively and exits on completion.
	 * - `--output-format stream-json` emits the per-event NDJSON that
	 *   {@link parseEvents} consumes (including the chat-id event used for resume).
	 * - `--model <model>` pins the concrete model resolved upstream.
	 * - `--force` allows all tool actions without prompting — the analog of Claude
	 *   Code's `bypassPermissions`, since workers run unattended in an isolated
	 *   worktree where prompts would deadlock a headless process.
	 * - `--resume <id>` is emitted ONLY on follow-up turns; the first turn omits it
	 *   so Cursor starts a fresh chat.
	 *
	 * Returned as an argv array (never a shell string) so no value is subject to
	 * shell interpolation.
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		return [
			"cursor-agent",
			"-p",
			opts.prompt ?? "",
			"--output-format",
			"stream-json",
			"--model",
			opts.model,
			"--force",
			// Only resume when a prior turn handed us a real chat id. An empty string
			// is treated as "no resume" so the first turn opens a new chat.
			...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
		];
	}

	/**
	 * Build argv for an ATTENDED interactive Cursor session.
	 *
	 * Run in the foreground with inherited stdio so the operator chats directly
	 * (`coordinator start`). `cursor-agent` has no `--append-system-prompt` flag, so
	 * the agent's role must be supplied via the `AGENTS.md` overlay;
	 * `systemPrompt`/`permissionMode` are accepted for interface parity but not
	 * passed as flags. A seed message becomes the initial prompt while the TUI
	 * stays interactive.
	 */
	buildInteractiveSpawn(opts: InteractiveSpawnOpts): string[] {
		const argv = ["cursor-agent", "--model", opts.model];
		if (opts.initialMessage && opts.initialMessage.length > 0) {
			argv.push(opts.initialMessage);
		}
		return argv;
	}

	/**
	 * Provider env vars for the resolved model (API keys, base URLs).
	 *
	 * Auth is never hardcoded here — it is whatever the provider layer resolved
	 * onto the model (empty for subscription/OAuth login, `CURSOR_API_KEY` for an
	 * api-key/env provider). A fresh object is returned so a caller mutating the
	 * result cannot leak back into shared config.
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return { ...(model.env ?? {}) };
	}

	/**
	 * Build argv for a one-shot, non-streaming call (`cursor-agent -p
	 * --output-format text`). Used by AI-assisted merge resolution and skill
	 * distillation, where we want only the final text answer. The model is appended
	 * only when provided so the caller can defer to Cursor's own default.
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const argv = ["cursor-agent", "-p", prompt, "--output-format", "text"];
		if (model !== undefined) {
			argv.push("--model", model);
		}
		return argv;
	}

	/**
	 * Parse Cursor's `--output-format stream-json` stdout into normalized
	 * {@link AgentEvent}s.
	 *
	 * The stream is NDJSON: one JSON object per line, but pipe chunk boundaries do
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
					const event = parseCursorLine(line);
					if (event) yield event;
				}
			}

			const tail = parseCursorLine(buffer);
			if (tail) yield tail;
		} finally {
			reader.releaseLock();
		}
	}
}

/**
 * Parse a single `cursor-agent` stream-json line into an {@link AgentEvent}, or
 * `null` for a blank or unparseable line. We accept any of the common chat-id key
 * spellings so resume keeps working across CLI versions, mirroring the resilience
 * of the Claude parser.
 */
function parseCursorLine(line: string): AgentEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (typeof raw !== "object" || raw === null) return null;
	const msg = raw as Record<string, unknown>;

	const event: AgentEvent = {
		type: typeof msg.type === "string" ? msg.type : "unknown",
		raw,
	};

	for (const candidate of [msg.chat_id, msg.chatId, msg.session_id, msg.sessionId]) {
		if (typeof candidate === "string" && candidate.length > 0) {
			event.sessionId = candidate;
			break;
		}
	}

	const tool = extractCursorTool(msg);
	if (tool !== undefined) event.tool = tool;

	const usage = extractCursorUsage(msg);
	if (usage !== undefined) event.usage = usage;

	// A `result` event with `is_error` carries the failure message in `result`.
	if (msg.type === "result" && msg.is_error === true && typeof msg.result === "string") {
		event.error = msg.result;
	}

	return event;
}

/**
 * Pull a tool name from a Cursor event. Cursor emits dedicated `tool_call` events
 * whose `tool_call` object is keyed by the tool (`shellToolCall`, `editToolCall`,
 * `readToolCall`, …) — we map that key to a short name (`shell`, `edit`, …). It
 * also nests `{ type: "tool_use", name }` blocks in assistant `message.content`
 * (the Claude shape), handled as a fallback. Returns `undefined` if no tool.
 */
function extractCursorTool(msg: Record<string, unknown>): string | undefined {
	if (msg.type === "tool_call" && typeof msg.tool_call === "object" && msg.tool_call !== null) {
		const key = Object.keys(msg.tool_call as Record<string, unknown>)[0];
		if (key) return key.replace(/ToolCall$/, "").toLowerCase() || key;
	}

	const message = msg.message;
	if (typeof message !== "object" || message === null) return undefined;
	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		if (b.type === "tool_use" && typeof b.name === "string") return b.name;
	}
	return undefined;
}

/**
 * Pull token usage from a Cursor `result` event's `usage`
 * (`{ inputTokens, outputTokens, cache… }`). Tokens are input + output (cache
 * counts are reported separately); Cursor gives no USD figure, so cost is 0.
 */
function extractCursorUsage(
	msg: Record<string, unknown>,
): { tokens: number; costUsd: number } | undefined {
	if (msg.type !== "result") return undefined;
	const usage = msg.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as Record<string, unknown>;
	const input = typeof u.inputTokens === "number" ? u.inputTokens : 0;
	const output = typeof u.outputTokens === "number" ? u.outputTokens : 0;
	const tokens = input + output;
	if (tokens === 0) return undefined;
	return { tokens, costUsd: 0 };
}

/** Singleton for callers that do not need dependency injection. */
export const cursorRuntime = new CursorRuntime();
