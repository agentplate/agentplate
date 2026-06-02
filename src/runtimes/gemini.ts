/**
 * Google Gemini runtime adapter (`gemini` CLI).
 *
 * Drives Google's `gemini` CLI in headless mode. Like Claude Code and Codex,
 * Gemini authenticates with its OWN login: a "Login with Google" OAuth session
 * under `~/.gemini/`. When the active provider uses `authMode: "subscription"`,
 * the provider layer injects no key and Gemini uses that login; an `api-key`/`env`
 * provider flows `GEMINI_API_KEY` through {@link GeminiRuntime.buildEnv}.
 *
 * A headless turn is `gemini -p … --output-format stream-json`, whose stdout is a
 * stream of JSONL events (`init` / `message` / `result`); {@link parseEvents}
 * normalizes them. `--yolo` auto-approves tool actions, and `--skip-trust` is
 * REQUIRED: in an untrusted folder (e.g. a fresh worktree) Gemini silently
 * downgrades the approval mode to "default" and then deadlocks/aborts a headless
 * turn it can't prompt in. The session id comes from the `init` event; Gemini's
 * `--resume` is index-based (not a session uuid), so turns run fresh.
 *
 * Validated against gemini-cli 0.44.1 flag + JSON-event shapes.
 */

import type { ResolvedModel } from "../types.ts";
import type { AgentEvent, AgentRuntime, DirectSpawnOpts, InteractiveSpawnOpts } from "./types.ts";

export class GeminiRuntime implements AgentRuntime {
	/** Registry id; also the value users pass to `--runtime gemini`. */
	readonly id = "gemini";

	/** Beta: validated against gemini-cli 0.44.1 flag + JSON-event shapes. */
	readonly stability = "beta" as const;

	/** Gemini reads `GEMINI.md` from the working directory at startup. */
	readonly instructionPath = "GEMINI.md";

	/**
	 * Build argv for a single headless turn (`gemini -p … -o stream-json`).
	 *
	 * `--prompt <text>` runs non-interactively and exits. `--model` pins the model;
	 * `--output-format stream-json` emits the per-event JSONL {@link parseEvents}
	 * consumes. `--yolo` auto-approves tools and `--skip-trust` keeps that mode in
	 * an untrusted worktree (without it Gemini reverts to prompting and the headless
	 * turn fails). Gemini has no uuid-based resume, so `resumeSessionId` is ignored.
	 */
	buildDirectSpawn(opts: DirectSpawnOpts): string[] {
		return [
			"gemini",
			"--skip-trust",
			"--yolo",
			"--model",
			opts.model,
			"--output-format",
			"stream-json",
			"--prompt",
			opts.prompt ?? "",
		];
	}

	/**
	 * Build argv for an ATTENDED interactive Gemini session.
	 *
	 * Foreground with inherited stdio so the operator chats directly. `--skip-trust`
	 * avoids the trust prompt; in auto/bypass mode `--yolo` auto-approves actions,
	 * while `--safe` (`"default"`) leaves Gemini's in-TUI approval prompts. Gemini
	 * has no system-prompt flag, so the role is supplied via the `GEMINI.md` overlay.
	 * A seed message uses `--prompt-interactive` so the TUI stays interactive.
	 */
	buildInteractiveSpawn(opts: InteractiveSpawnOpts): string[] {
		const argv = ["gemini", "--skip-trust"];
		if (opts.permissionMode === "bypass") argv.push("--yolo");
		argv.push("--model", opts.model);
		if (opts.initialMessage && opts.initialMessage.length > 0) {
			argv.push("--prompt-interactive", opts.initialMessage);
		}
		return argv;
	}

	/** Provider env vars for the resolved model (fresh copy; empty for OAuth login). */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return { ...(model.env ?? {}) };
	}

	/** Build argv for a one-shot, non-streaming call (`gemini -p -o text`). */
	buildPrintCommand(prompt: string, model?: string): string[] {
		const argv = ["gemini", "--skip-trust", "--output-format", "text"];
		if (model !== undefined) {
			argv.push("--model", model);
		}
		argv.push("--prompt", prompt);
		return argv;
	}

	/**
	 * Parse Gemini's `--output-format stream-json` stdout into normalized
	 * {@link AgentEvent}s. The stream is JSONL; pipe chunk boundaries don't align to
	 * newlines, so a partial trailing line is buffered across reads. Malformed lines
	 * are skipped.
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
					const event = parseGeminiLine(line);
					if (event) yield event;
				}
			}
			const tail = parseGeminiLine(buffer);
			if (tail) yield tail;
		} finally {
			reader.releaseLock();
		}
	}
}

/**
 * Parse a single `gemini -o stream-json` line into an {@link AgentEvent}, or `null`
 * for a blank/unparseable line. Gemini emits `init` ({ session_id, model }),
 * `message` ({ role, content }), and `result` ({ status, stats }).
 */
function parseGeminiLine(line: string): AgentEvent | null {
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

	// The opening `init` event carries the session id.
	if (typeof msg.session_id === "string" && msg.session_id.length > 0) {
		event.sessionId = msg.session_id;
	}

	// Tool activity: a tool-call event/message names the tool.
	if (msg.type === "tool_call" || msg.type === "tool") {
		const name = msg.name ?? msg.tool;
		if (typeof name === "string") event.tool = name;
	}

	// The `result` event carries token usage and success/error status.
	if (msg.type === "result") {
		const stats = msg.stats;
		if (typeof stats === "object" && stats !== null) {
			const total = (stats as Record<string, unknown>).total_tokens;
			if (typeof total === "number" && total > 0) event.usage = { tokens: total, costUsd: 0 };
		}
		if (typeof msg.status === "string" && msg.status !== "success") {
			const detail = typeof msg.error === "string" ? msg.error : msg.status;
			event.error = `gemini turn ${msg.status}: ${detail}`;
		}
	}

	return event;
}

/** Singleton for callers that do not need dependency injection. */
export const geminiRuntime = new GeminiRuntime();
