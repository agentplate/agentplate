/**
 * OpenCode runtime adapter (SST OpenCode).
 *
 * Drives the `opencode` CLI. OpenCode reads an `AGENTS.md` instruction file from
 * the working directory at startup (so the overlay is written there, not passed
 * as a flag), and selects a model with `--model provider/model`. Provider auth is
 * OpenCode's own (`opencode auth login`), so Agentplate injects no key — like a
 * subscription runtime.
 *
 * The message is a POSITIONAL argument (`opencode run [message..]`), NOT a flag —
 * a leading `--prompt` makes OpenCode print usage and do nothing. Headless turns
 * use `opencode run --format json`, whose stdout is a stream of JSON events
 * (`{ type, sessionID, … }`); {@link OpenCodeRuntime.parseEvents} normalizes them.
 * Session continuity uses `--session <id>` captured from those events.
 *
 * Validated against opencode 1.15.x flag + JSON-event shapes.
 */

import type { ResolvedModel } from "../types.ts";
import type { AgentEvent, AgentRuntime, DirectSpawnOpts, InteractiveSpawnOpts } from "./types.ts";

/**
 * Auto-approve policy for unattended OpenCode turns, set via `OPENCODE_PERMISSION`
 * (same JSON shape as the `permission` block in `opencode.json`). OpenCode has no
 * stable first-class "skip permissions" CLI flag — the `run`-only
 * `--dangerously-skip-permissions` is fragile and does NOT cover the hardcoded
 * `external_directory → ask` default, which would still block a headless agent.
 * This env var is the robust, version-stable mechanism. We allow the everyday
 * tools (and `external_directory`, the headless gotcha) while DENYING the most
 * destructive shell commands — using `deny` (not `ask`, which would hang a turn
 * that has no TTY to answer it). Last-match-wins, so the catch-all comes first.
 */
/**
 * OpenCode addresses models as `provider/model` and rejects a bare id with
 * "Invalid model format". A bare id almost always means an OpenCode Zen model
 * (opencode's own `opencode` provider), so default that prefix. Ids that already
 * carry a provider (`openrouter/…`, `opencode/…`, `anthropic/…`) pass through
 * unchanged.
 */
export function opencodeModel(model: string): string {
	return model.includes("/") ? model : `opencode/${model}`;
}

const OPENCODE_BYPASS_PERMISSION = JSON.stringify({
	bash: {
		"*": "allow",
		"rm -rf *": "deny",
		"sudo *": "deny",
		"mkfs *": "deny",
		"dd *": "deny",
	},
	edit: "allow",
	webfetch: "allow",
	external_directory: "allow",
});

export class OpenCodeRuntime implements AgentRuntime {
	/** Registry id; the value users pass to `--runtime opencode`. */
	readonly id = "opencode";

	/** Beta: validated against opencode 1.15.x flag shapes. */
	readonly stability = "beta" as const;

	/** OpenCode reads `AGENTS.md` from the cwd at startup. */
	readonly instructionPath = "AGENTS.md";

	/**
	 * Build argv for a single headless turn (`opencode run`).
	 *
	 * `run <message>` executes the prompt non-interactively — the message is the
	 * trailing POSITIONAL (the `run` subcommand has no `--prompt` flag and prints
	 * usage if given one). `--model provider/model` pins the model, `--format json`
	 * emits the per-event JSON that {@link parseEvents} consumes, and `--session
	 * <id>` resumes a prior turn (omitted on the first turn).
	 *
	 * Permission auto-approval is handled by the `OPENCODE_PERMISSION` env var (see
	 * {@link buildEnv}), NOT a CLI flag: the `--dangerously-skip-permissions` flag
	 * is `run`-only, fragile across versions, and misses the `external_directory`
	 * default that blocks headless agents.
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		return [
			"opencode",
			"run",
			"--model",
			opencodeModel(opts.model),
			"--format",
			"json",
			...(opts.resumeSessionId ? ["--session", opts.resumeSessionId] : []),
			// Message is the trailing positional argument.
			opts.prompt ?? "",
		];
	}

	/**
	 * Build argv for an ATTENDED interactive OpenCode session.
	 *
	 * Run in the foreground with inherited stdio so the operator chats directly
	 * (`coordinator start`). OpenCode has no system-prompt flag, so the agent's
	 * role is supplied via the `AGENTS.md` overlay. The seed message uses the
	 * top-level `--prompt` flag (the interactive entrypoint, unlike `run`, has no
	 * positional message).
	 *
	 * NOTE: `--dangerously-skip-permissions` is a `run`-only flag — passing it to
	 * the interactive entrypoint makes OpenCode error out (exit 1). The attended
	 * coordinator approves actions in the TUI instead, so `permissionMode` is
	 * accepted for interface parity but not translated to a flag here.
	 */
	buildInteractiveSpawn(opts: InteractiveSpawnOpts): string[] {
		const argv = ["opencode", "--model", opencodeModel(opts.model)];
		if (opts.initialMessage && opts.initialMessage.length > 0) {
			argv.push("--prompt", opts.initialMessage);
		}
		return argv;
	}

	/**
	 * Provider env vars for the resolved model, plus `OPENCODE_PERMISSION` so an
	 * unattended turn auto-approves tool actions instead of deadlocking on a
	 * permission prompt (OpenCode's robust, version-stable bypass mechanism). The
	 * caller decides whether to apply this: the headless turn-runner always does
	 * (workers are unattended); the interactive coordinator applies it only in
	 * auto/bypass mode so `--safe` keeps OpenCode's in-TUI approval prompts.
	 */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return { ...(model.env ?? {}), OPENCODE_PERMISSION: OPENCODE_BYPASS_PERMISSION };
	}

	/**
	 * Build argv for a one-shot, non-streaming call (`opencode run --format text`).
	 * The model is appended only when provided; the prompt is the trailing
	 * positional.
	 */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const argv = ["opencode", "run", "--format", "text"];
		if (model !== undefined) {
			argv.push("--model", opencodeModel(model));
		}
		argv.push(prompt);
		return argv;
	}

	/**
	 * Parse OpenCode's `--format json` stdout into normalized {@link AgentEvent}s.
	 *
	 * The stream is JSONL: one JSON object per line (`{ type, sessionID, … }`), but
	 * pipe chunk boundaries do NOT align to newlines, so we keep a `buffer` of the
	 * trailing partial line across reads and only parse once a `\n` completes it.
	 * Malformed lines are skipped so a partial flush never aborts the turn.
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
					const event = parseOpenCodeLine(line);
					if (event) yield event;
				}
			}

			const tail = parseOpenCodeLine(buffer);
			if (tail) yield tail;
		} finally {
			reader.releaseLock();
		}
	}
}

/**
 * Parse a single `opencode run --format json` line into an {@link AgentEvent}, or
 * `null` for a blank/unparseable line. OpenCode events are `{ type, timestamp,
 * sessionID, … }`; we pass the `type` through (the feed labels any type), capture
 * the session id for `--session`, and best-effort lift a tool name.
 */
function parseOpenCodeLine(line: string): AgentEvent | null {
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

	for (const candidate of [msg.sessionID, msg.sessionId, msg.session_id]) {
		if (typeof candidate === "string" && candidate.length > 0) {
			event.sessionId = candidate;
			break;
		}
	}

	const tool = extractOpenCodeTool(msg);
	if (tool !== undefined) event.tool = tool;

	// Surface the failure reason on error events (e.g. "Model not found: …") so a
	// failed agent shows WHY in the feed/logs instead of a blank "error".
	if (typeof msg.error === "object" && msg.error !== null) {
		const err = msg.error as Record<string, unknown>;
		const data = (typeof err.data === "object" && err.data !== null ? err.data : {}) as Record<
			string,
			unknown
		>;
		const message =
			(typeof data.message === "string" && data.message) ||
			(typeof err.message === "string" && err.message) ||
			(typeof err.name === "string" && err.name) ||
			undefined;
		if (message) event.error = message;
	}

	return event;
}

/**
 * Best-effort tool name from an OpenCode event. Tool activity surfaces either as a
 * top-level `tool` field or nested in a `part`/`properties.part` of type "tool".
 * Returns `undefined` when no tool is named.
 */
function extractOpenCodeTool(msg: Record<string, unknown>): string | undefined {
	if (typeof msg.tool === "string") return msg.tool;

	const part = (() => {
		if (typeof msg.part === "object" && msg.part !== null)
			return msg.part as Record<string, unknown>;
		const props = msg.properties;
		if (typeof props === "object" && props !== null) {
			const p = (props as Record<string, unknown>).part;
			if (typeof p === "object" && p !== null) return p as Record<string, unknown>;
		}
		return null;
	})();
	if (part && part.type === "tool") {
		if (typeof part.tool === "string") return part.tool;
		if (typeof part.name === "string") return part.name;
	}
	return undefined;
}

/** Singleton for callers that do not need dependency injection. */
export const openCodeRuntime = new OpenCodeRuntime();
