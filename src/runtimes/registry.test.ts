import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ValidationError } from "../errors.ts";
import type { ResolvedModel, RuntimeConfig } from "../types.ts";
import { ClaudeRuntime } from "./claude.ts";
import { CodexRuntime } from "./codex.ts";
import { CursorRuntime } from "./cursor.ts";
import { GeminiRuntime } from "./gemini.ts";
import { MockRuntime } from "./mock.ts";
import { OpenCodeRuntime, opencodeModel } from "./opencode.ts";
import { getRuntime, getRuntimeNames, runtimeNameForCapability } from "./registry.ts";
import type { AgentEvent, DirectSpawnOpts } from "./types.ts";

describe("runtimeNameForCapability", () => {
	const rt: RuntimeConfig = { default: "claude", capabilities: { scout: "codex" } };
	test("explicit override wins over everything", () => {
		expect(runtimeNameForCapability(rt, "scout", "gemini")).toBe("gemini");
	});
	test("per-capability override applies when set", () => {
		expect(runtimeNameForCapability(rt, "scout")).toBe("codex");
	});
	test("falls back to the default runtime", () => {
		expect(runtimeNameForCapability(rt, "builder")).toBe("claude");
		expect(runtimeNameForCapability({ default: "opencode" }, "scout")).toBe("opencode");
	});
});

// Minimal DirectSpawnOpts builder for argv-shape assertions. `cwd` and
// `instructionPath` are required by the type but irrelevant to argv here.
function spawnOpts(overrides: Partial<DirectSpawnOpts> = {}): DirectSpawnOpts {
	return {
		cwd: "/tmp/wt",
		model: "claude-sonnet-4-6",
		instructionPath: ".claude/CLAUDE.md",
		...overrides,
	};
}

// Build a ReadableStream of UTF-8 bytes from string chunks, to feed parseEvents
// the same shape Bun.spawn's stdout produces (no real subprocess needed).
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

describe("ClaudeRuntime", () => {
	const runtime = new ClaudeRuntime();

	test("static metadata", () => {
		expect(runtime.id).toBe("claude");
		expect(runtime.stability).toBe("stable");
		expect(runtime.instructionPath).toBe(".claude/CLAUDE.md");
	});

	test("buildDirectSpawn omits --resume on the first turn", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ prompt: "do the thing" }));
		expect(argv).toEqual([
			"claude",
			"-p",
			"do the thing",
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			"claude-sonnet-4-6",
			"--disallowedTools",
			"Task",
			"Agent",
			"Workflow",
			"--permission-mode",
			"bypassPermissions",
		]);
		expect(argv).not.toContain("--resume");
	});

	test("blocks Claude Code's native spawn tools so sling is the only spawn path", () => {
		// Headless turns (workers/leads): Task/Agent/Workflow disallowed — but workers
		// MUST still be able to edit, so file-mutation tools stay available.
		const direct = runtime.buildDirectSpawn(spawnOpts({ prompt: "go" }));
		const di = direct.indexOf("--disallowedTools");
		expect(di).toBeGreaterThan(-1);
		expect(direct.slice(di + 1, di + 4)).toEqual(["Task", "Agent", "Workflow"]);
		expect(direct).not.toContain("Edit"); // workers can edit
		expect(direct).not.toContain("Write");

		// Interactive coordinator: spawn block, and the variadic must NOT swallow the
		// trailing seed message.
		const interactive = runtime.buildInteractiveSpawn?.({
			model: "m",
			initialMessage: "build a todo app",
		});
		expect(interactive).toContain("--disallowedTools");
		expect(interactive).toContain("Task");
		expect(interactive?.[interactive.length - 1]).toBe("build a todo app");
	});

	test("interactive coordinator is dispatch-only: file-mutation tools are blocked", () => {
		const argv = runtime.buildInteractiveSpawn?.({ model: "m" }) ?? [];
		const di = argv.indexOf("--disallowedTools");
		const blocked = argv.slice(di + 1, argv.indexOf("--permission-mode"));
		// Coordinator hires agents; it must not implement. Bash/Read stay (so sling +
		// surveying work); edit tools and native sub-agent tools are blocked.
		expect(blocked).toEqual([
			"Task",
			"Agent",
			"Workflow",
			"Edit",
			"Write",
			"MultiEdit",
			"NotebookEdit",
		]);
		expect(argv).not.toContain("Bash");
		expect(argv).not.toContain("Read");
	});

	test("buildDirectSpawn includes --resume <id> on a follow-up turn", () => {
		const argv = runtime.buildDirectSpawn(
			spawnOpts({ prompt: "continue", resumeSessionId: "sess-123" }),
		);
		const idx = argv.indexOf("--resume");
		expect(idx).toBeGreaterThan(-1);
		expect(argv[idx + 1]).toBe("sess-123");
	});

	test("buildDirectSpawn treats an empty resumeSessionId as no resume", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ resumeSessionId: "" }));
		expect(argv).not.toContain("--resume");
	});

	test("buildDirectSpawn defaults a missing prompt to empty string", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts());
		// `-p` must always be followed by a string argument (here "").
		expect(argv[1]).toBe("-p");
		expect(argv[2]).toBe("");
	});

	test("buildInteractiveSpawn builds an attended session (no -p, default perms)", () => {
		const argv = runtime.buildInteractiveSpawn?.({
			model: "claude-opus-4-8",
			systemPrompt: "You are the coordinator.",
			permissionMode: "default",
		});
		expect(argv).toBeDefined();
		expect(argv?.[0]).toBe("claude");
		expect(argv).not.toContain("-p"); // interactive, not headless
		expect(argv).toContain("--model");
		expect(argv).toContain("claude-opus-4-8");
		expect(argv).toContain("--permission-mode");
		expect(argv).toContain("default");
		expect(argv).toContain("--append-system-prompt");
		expect(argv).toContain("You are the coordinator.");
	});

	test("buildInteractiveSpawn appends a seed message as the trailing arg", () => {
		const argv = runtime.buildInteractiveSpawn?.({
			model: "m",
			initialMessage: "build a todo app",
		});
		expect(argv?.[argv.length - 1]).toBe("build a todo app");
	});

	test("buildInteractiveSpawn maps bypass → bypassPermissions (auto mode)", () => {
		const argv = runtime.buildInteractiveSpawn?.({ model: "m", permissionMode: "bypass" });
		expect(argv).toContain("--permission-mode");
		expect(argv).toContain("bypassPermissions");
		expect(argv).not.toContain("default");
	});

	test("buildInteractiveSpawn omits the system prompt flag when none given", () => {
		const argv = runtime.buildInteractiveSpawn?.({ model: "m" });
		expect(argv).not.toContain("--append-system-prompt");
	});

	test("buildPrintCommand emits text output and appends model only when given", () => {
		expect(runtime.buildPrintCommand("hi")).toEqual([
			"claude",
			"-p",
			"hi",
			"--output-format",
			"text",
		]);
		expect(runtime.buildPrintCommand("hi", "opus")).toEqual([
			"claude",
			"-p",
			"hi",
			"--output-format",
			"text",
			"--model",
			"opus",
		]);
	});

	test("buildEnv copies provider env and is not the same reference", () => {
		const model: ResolvedModel = { model: "m", env: { ANTHROPIC_API_KEY: "sk-test" } };
		const env = runtime.buildEnv(model);
		expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
		// A fresh object — mutating the result must not corrupt the source.
		env.EXTRA = "x";
		expect(model.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
	});

	test("buildEnv returns an empty object when the model has no env", () => {
		expect(runtime.buildEnv({ model: "m" })).toEqual({});
	});

	test("parseEvents yields one event per JSON line and captures sessionId", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" })}\n`,
			`${JSON.stringify({ type: "result", is_error: false })}\n`,
		]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("system");
		expect(events[0]?.sessionId).toBe("abc-123");
		// Only the init/system event carries a session id.
		expect(events[1]?.type).toBe("result");
		expect(events[1]?.sessionId).toBeUndefined();
	});

	test("parseEvents reassembles a JSON object split across chunk boundaries", async () => {
		const full = JSON.stringify({ type: "system", session_id: "split-1" });
		const mid = Math.floor(full.length / 2);
		// Newline withheld until the final chunk — exercises cross-read buffering.
		const stream = streamFromChunks([full.slice(0, mid), `${full.slice(mid)}\n`]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(1);
		expect(events[0]?.sessionId).toBe("split-1");
	});

	test("parseEvents lifts a tool_use name into the tool field", async () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Edit", input: {} }] },
		});
		const stream = streamFromChunks([`${line}\n`]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("assistant");
		expect(events[0]?.tool).toBe("Edit");
	});

	test("parseEvents extracts token usage + cost from a result event", async () => {
		const line = JSON.stringify({
			type: "result",
			total_cost_usd: 0.0123,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_creation_input_tokens: 10,
				cache_read_input_tokens: 5,
			},
		});
		const stream = streamFromChunks([`${line}\n`]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(1);
		expect(events[0]?.usage).toEqual({ tokens: 165, costUsd: 0.0123 });
	});

	test("parseEvents leaves usage undefined for non-result events / zero spend", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`,
			`${JSON.stringify({ type: "result", total_cost_usd: 0, usage: {} })}\n`,
		]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);
		expect(events[0]?.usage).toBeUndefined();
		expect(events[1]?.usage).toBeUndefined();
	});

	test("parseEvents surfaces an error message from an is_error result", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "result", is_error: true, result: "rate limit exceeded" })}\n`,
		]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);
		expect(events[0]?.error).toBe("rate limit exceeded");
	});

	test("parseEvents skips blank lines and malformed JSON without throwing", async () => {
		const valid = JSON.stringify({ type: "result" });
		const stream = streamFromChunks([
			"\n",
			"not json at all\n",
			"{ partial: \n", // unparseable fragment terminated by newline
			`${valid}\n`,
		]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("result");
	});

	test("parseEvents emits a final line that lacks a trailing newline", async () => {
		const line = JSON.stringify({ type: "result", session_id: "tail-1" });
		const stream = streamFromChunks([line]); // no "\n"

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(1);
		expect(events[0]?.sessionId).toBe("tail-1");
	});
});

describe("MockRuntime", () => {
	const runtime = new MockRuntime();
	// Snapshot and restore the env vars the mock reads so tests stay isolated.
	let savedCmd: string | undefined;
	let savedPrint: string | undefined;

	beforeEach(() => {
		savedCmd = process.env.AGENTPLATE_MOCK_CMD;
		savedPrint = process.env.AGENTPLATE_MOCK_PRINT;
		delete process.env.AGENTPLATE_MOCK_CMD;
		delete process.env.AGENTPLATE_MOCK_PRINT;
	});

	afterEach(() => {
		if (savedCmd === undefined) delete process.env.AGENTPLATE_MOCK_CMD;
		else process.env.AGENTPLATE_MOCK_CMD = savedCmd;
		if (savedPrint === undefined) delete process.env.AGENTPLATE_MOCK_PRINT;
		else process.env.AGENTPLATE_MOCK_PRINT = savedPrint;
	});

	test("static metadata", () => {
		expect(runtime.id).toBe("mock");
		expect(runtime.stability).toBe("experimental");
		expect(runtime.instructionPath).toBe("CLAUDE.md");
	});

	test("buildDirectSpawn defaults to a no-op `true` command", () => {
		expect(runtime.buildDirectSpawn(spawnOpts())).toEqual(["bash", "-lc", "true"]);
	});

	test("buildDirectSpawn uses AGENTPLATE_MOCK_CMD when set", () => {
		process.env.AGENTPLATE_MOCK_CMD = "echo hi > out.txt && git add -A";
		expect(runtime.buildDirectSpawn(spawnOpts())).toEqual([
			"bash",
			"-lc",
			"echo hi > out.txt && git add -A",
		]);
	});

	test("buildPrintCommand defaults to `echo mock` and honors AGENTPLATE_MOCK_PRINT", () => {
		expect(runtime.buildPrintCommand("ignored")).toEqual(["bash", "-lc", "echo mock"]);
		process.env.AGENTPLATE_MOCK_PRINT = "echo custom";
		expect(runtime.buildPrintCommand("ignored")).toEqual(["bash", "-lc", "echo custom"]);
	});

	test("buildInteractiveSpawn is a scripted bash command (default `true`)", () => {
		const saved = process.env.AGENTPLATE_MOCK_INTERACTIVE;
		delete process.env.AGENTPLATE_MOCK_INTERACTIVE;
		expect(runtime.buildInteractiveSpawn?.({ model: "m" })).toEqual(["bash", "-lc", "true"]);
		if (saved === undefined) delete process.env.AGENTPLATE_MOCK_INTERACTIVE;
		else process.env.AGENTPLATE_MOCK_INTERACTIVE = saved;
	});

	test("the scripted command actually runs in a real subprocess", async () => {
		// Real subprocess (no mocking): the argv from buildDirectSpawn must be
		// directly executable by Bun.spawn and produce the scripted output.
		process.env.AGENTPLATE_MOCK_CMD = "printf agentplate-mock-ran";
		const argv = runtime.buildDirectSpawn(spawnOpts());
		const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
		expect(stdout).toBe("agentplate-mock-ran");
	});

	test("buildEnv copies provider env", () => {
		expect(runtime.buildEnv({ model: "m", env: { FOO: "bar" } })).toEqual({ FOO: "bar" });
		expect(runtime.buildEnv({ model: "m" })).toEqual({});
	});
});

describe("OpenCodeRuntime", () => {
	const runtime = new OpenCodeRuntime();

	test("metadata", () => {
		expect(runtime.id).toBe("opencode");
		expect(runtime.instructionPath).toBe("AGENTS.md");
	});

	test("metadata stability is beta", () => {
		expect(runtime.stability).toBe("beta");
	});

	test("buildDirectSpawn: positional message + json; permissions handled via env, not a flag", () => {
		const argv = runtime.buildDirectSpawn(
			spawnOpts({ prompt: "do it", model: "openrouter/gpt-4o" }),
		);
		expect(argv.slice(0, 2)).toEqual(["opencode", "run"]);
		// The `run` subcommand takes the message as a positional (no --prompt flag).
		expect(argv).not.toContain("--prompt");
		expect(argv[argv.length - 1]).toBe("do it");
		expect(argv).toContain("--model");
		expect(argv).toContain("openrouter/gpt-4o"); // provider-qualified, passes through
		expect(argv).toContain("--format");
		expect(argv).toContain("json");
		// Auto-approve is via OPENCODE_PERMISSION (buildEnv), not the fragile run-only flag.
		expect(argv).not.toContain("--dangerously-skip-permissions");
		expect(argv).not.toContain("--session"); // no resume on first turn
	});

	test("buildEnv injects OPENCODE_PERMISSION (allow + guardrails) alongside provider env", () => {
		const env = runtime.buildEnv({ model: "m", env: { OPENROUTER_API_KEY: "k" } });
		expect(env.OPENROUTER_API_KEY).toBe("k"); // provider env preserved
		const policy = JSON.parse(env.OPENCODE_PERMISSION ?? "{}");
		expect(policy.edit).toBe("allow");
		expect(policy.external_directory).toBe("allow"); // the headless gotcha
		expect(policy.bash["*"]).toBe("allow");
		expect(policy.bash["rm -rf *"]).toBe("deny"); // destructive guardrail (deny, not ask)
	});

	test("opencodeModel prefixes bare ids with opencode/ and leaves provider-qualified ids", () => {
		expect(opencodeModel("minimax-m3-free")).toBe("opencode/minimax-m3-free");
		expect(opencodeModel("opencode/minimax-m3-free")).toBe("opencode/minimax-m3-free");
		expect(opencodeModel("openrouter/google/gemini-2.5-flash-lite")).toBe(
			"openrouter/google/gemini-2.5-flash-lite",
		);
	});

	test("buildDirectSpawn normalizes a bare model to opencode/<model>", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ prompt: "x", model: "minimax-m3-free" }));
		const i = argv.indexOf("--model");
		expect(argv[i + 1]).toBe("opencode/minimax-m3-free");
	});

	test("buildDirectSpawn adds --session on resume and keeps the message last", () => {
		const argv = runtime.buildDirectSpawn(
			spawnOpts({ prompt: "go on", resumeSessionId: "sess-1" }),
		);
		const idx = argv.indexOf("--session");
		expect(idx).toBeGreaterThan(-1);
		expect(argv[idx + 1]).toBe("sess-1");
		expect(argv[argv.length - 1]).toBe("go on");
	});

	test("buildInteractiveSpawn seeds via top-level --prompt and never adds the run-only perm flag", () => {
		const argv = runtime.buildInteractiveSpawn?.({
			model: "openrouter/gpt-4o",
			permissionMode: "bypass",
			initialMessage: "build x",
		});
		expect(argv?.slice(0, 3)).toEqual(["opencode", "--model", "openrouter/gpt-4o"]);
		expect(argv).not.toContain("run");
		// --dangerously-skip-permissions is run-only; on the interactive entrypoint it
		// makes opencode exit 1, so it must NOT be passed here (TUI approves instead).
		expect(argv).not.toContain("--dangerously-skip-permissions");
		expect(argv).toContain("--prompt");
		expect(argv?.[argv.length - 1]).toBe("build x");
	});

	test("buildInteractiveSpawn without a seed is a bare attended session", () => {
		const argv = runtime.buildInteractiveSpawn?.({
			model: "openrouter/m",
			permissionMode: "default",
		});
		expect(argv).toEqual(["opencode", "--model", "openrouter/m"]);
	});

	test("buildPrintCommand emits text format with the prompt as a positional", () => {
		expect(runtime.buildPrintCommand("hi", "openrouter/gpt-4o")).toEqual([
			"opencode",
			"run",
			"--format",
			"text",
			"--model",
			"openrouter/gpt-4o",
			"hi",
		]);
		expect(runtime.buildPrintCommand("hi")).toEqual(["opencode", "run", "--format", "text", "hi"]);
	});

	test("parseEvents captures sessionID and passes event types through", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "step.start", sessionID: "ses_1", timestamp: 1 })}\n`,
			`${JSON.stringify({ type: "error", sessionID: "ses_1", error: { name: "X" } })}\n`,
		]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("step.start");
		expect(events[0]?.sessionId).toBe("ses_1");
		expect(events[1]?.type).toBe("error");
	});

	test("parseEvents lifts a tool name from a part of type tool, skips junk", async () => {
		const toolLine = JSON.stringify({
			type: "message.part.updated",
			sessionID: "ses_2",
			part: { type: "tool", tool: "bash" },
		});
		const stream = streamFromChunks(["\n", "not json\n", `${toolLine}\n`]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(1);
		expect(events[0]?.tool).toBe("bash");
	});

	test("parseEvents surfaces the error message (real opencode 'Model not found' shape)", async () => {
		const line = JSON.stringify({
			type: "error",
			sessionID: "ses_3",
			error: { name: "UnknownError", data: { message: "Model not found: openrouter/x" } },
		});
		const stream = streamFromChunks([`${line}\n`]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events[0]?.type).toBe("error");
		expect(events[0]?.error).toBe("Model not found: openrouter/x");
	});
});

describe("CodexRuntime", () => {
	const runtime = new CodexRuntime();

	test("metadata", () => {
		expect(runtime.id).toBe("codex");
		expect(runtime.stability).toBe("beta");
		expect(runtime.instructionPath).toBe("AGENTS.md");
	});

	test("buildDirectSpawn uses `codex exec --json --model …` with the bypass flag", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ prompt: "do it", model: "gpt-5-codex" }));
		expect(argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
		expect(argv).toContain("--model");
		expect(argv).toContain("gpt-5-codex");
		expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(argv[argv.length - 1]).toBe("do it"); // prompt is the trailing positional
		expect(argv).not.toContain("resume"); // no resume on the first turn
	});

	test("buildDirectSpawn uses the `resume <id>` subcommand on a follow-up turn", () => {
		const argv = runtime.buildDirectSpawn(
			spawnOpts({ prompt: "go on", resumeSessionId: "uuid-1" }),
		);
		expect(argv.slice(0, 4)).toEqual(["codex", "exec", "resume", "uuid-1"]);
		expect(argv).toContain("--json");
		expect(argv[argv.length - 1]).toBe("go on");
	});

	test("buildDirectSpawn treats an empty resumeSessionId as no resume", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ resumeSessionId: "" }));
		expect(argv).not.toContain("resume");
	});

	test("buildInteractiveSpawn is an attended `codex --model` (no exec)", () => {
		const argv = runtime.buildInteractiveSpawn?.({ model: "gpt-5-codex" });
		expect(argv).toEqual(["codex", "--model", "gpt-5-codex"]);
		expect(argv).not.toContain("exec");
	});

	test("buildInteractiveSpawn appends a seed message as the trailing arg", () => {
		const argv = runtime.buildInteractiveSpawn?.({ model: "m", initialMessage: "build x" });
		expect(argv?.[argv.length - 1]).toBe("build x");
	});

	test("buildPrintCommand stays non-interactive and appends model only when given", () => {
		expect(runtime.buildPrintCommand("hi")).toEqual([
			"codex",
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"hi",
		]);
		const withModel = runtime.buildPrintCommand("hi", "gpt-5-codex");
		expect(withModel).toContain("--model");
		expect(withModel).toContain("gpt-5-codex");
		expect(withModel[withModel.length - 1]).toBe("hi");
	});

	test("buildEnv copies provider env and is a fresh object", () => {
		const model: ResolvedModel = { model: "m", env: { OPENAI_API_KEY: "sk-test" } };
		const env = runtime.buildEnv(model);
		expect(env).toEqual({ OPENAI_API_KEY: "sk-test" });
		env.EXTRA = "x";
		expect(model.env).toEqual({ OPENAI_API_KEY: "sk-test" });
	});

	test("buildEnv returns empty for subscription/OAuth login (no key injected)", () => {
		expect(runtime.buildEnv({ model: "m" })).toEqual({});
	});

	test("parseEvents captures the session id from a session_configured event", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ id: "0", msg: { type: "session_configured", session_id: "sess-9" } })}\n`,
			`${JSON.stringify({ id: "1", msg: { type: "task_complete" } })}\n`,
		]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("session_configured");
		expect(events[0]?.sessionId).toBe("sess-9");
		expect(events[1]?.type).toBe("task_complete");
		expect(events[1]?.sessionId).toBeUndefined();
	});

	test("parseEvents lifts a tool name from exec_command_begin / mcp_tool_call_begin", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ msg: { type: "exec_command_begin", command: ["ls"] } })}\n`,
			`${JSON.stringify({ msg: { type: "mcp_tool_call_begin", tool: "search" } })}\n`,
		]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events[0]?.tool).toBe("shell");
		expect(events[1]?.tool).toBe("search");
	});

	test("parseEvents tolerates the flatter thread/item shape and skips junk", async () => {
		const stream = streamFromChunks([
			"\n",
			"not json\n",
			`${JSON.stringify({ type: "thread.started", thread_id: "th-1" })}\n`,
		]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("thread.started");
		expect(events[0]?.sessionId).toBe("th-1");
	});

	test("parseEvents handles the real 0.128 thread/item stream (tool + usage)", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "thread.started", thread_id: "th-9" })}\n`,
			`${JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "Hi." } })}\n`,
			`${JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls" } })}\n`,
			`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20, reasoning_output_tokens: 5 } })}\n`,
		]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(4);
		expect(events[0]?.sessionId).toBe("th-9");
		expect(events[1]?.tool).toBeUndefined(); // agent_message is not a tool
		expect(events[2]?.tool).toBe("shell"); // command_execution → shell
		// input + output only (cached/reasoning are subsets), cost unknown → 0.
		expect(events[3]?.usage).toEqual({ tokens: 120, costUsd: 0 });
	});
});

describe("GeminiRuntime", () => {
	const runtime = new GeminiRuntime();

	test("metadata", () => {
		expect(runtime.id).toBe("gemini");
		expect(runtime.stability).toBe("beta");
		expect(runtime.instructionPath).toBe("GEMINI.md");
	});

	test("buildDirectSpawn uses stream-json + --skip-trust + --yolo (headless)", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ prompt: "do it", model: "gemini-2.5-pro" }));
		expect(argv[0]).toBe("gemini");
		expect(argv).toContain("--skip-trust"); // untrusted-worktree gotcha
		expect(argv).toContain("--yolo");
		expect(argv).toContain("--model");
		expect(argv).toContain("gemini-2.5-pro");
		expect(argv).toContain("--output-format");
		expect(argv).toContain("stream-json");
		expect(argv).toContain("--prompt");
		expect(argv[argv.length - 1]).toBe("do it");
	});

	test("buildDirectSpawn ignores resumeSessionId (Gemini resume is index-based)", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ resumeSessionId: "sess-1" }));
		expect(argv).not.toContain("sess-1");
		expect(argv).not.toContain("--resume");
	});

	test("buildInteractiveSpawn: --skip-trust always; --yolo only in bypass; seed via -i", () => {
		const bypass = runtime.buildInteractiveSpawn?.({
			model: "m",
			permissionMode: "bypass",
			initialMessage: "build x",
		});
		expect(bypass?.[0]).toBe("gemini");
		expect(bypass).toContain("--skip-trust");
		expect(bypass).toContain("--yolo");
		expect(bypass).toContain("--prompt-interactive");
		expect(bypass?.[bypass.length - 1]).toBe("build x");

		const safe = runtime.buildInteractiveSpawn?.({ model: "m", permissionMode: "default" });
		expect(safe).toContain("--skip-trust");
		expect(safe).not.toContain("--yolo"); // --safe keeps in-TUI approval
	});

	test("buildPrintCommand emits a text --prompt call with --skip-trust", () => {
		expect(runtime.buildPrintCommand("hi")).toEqual([
			"gemini",
			"--skip-trust",
			"--output-format",
			"text",
			"--prompt",
			"hi",
		]);
		const withModel = runtime.buildPrintCommand("hi", "gemini-2.5-flash");
		expect(withModel).toContain("--model");
		expect(withModel).toContain("gemini-2.5-flash");
	});

	test("buildEnv copies provider env and returns empty for subscription/OAuth login", () => {
		expect(runtime.buildEnv({ model: "m", env: { GEMINI_API_KEY: "k" } })).toEqual({
			GEMINI_API_KEY: "k",
		});
		expect(runtime.buildEnv({ model: "m" })).toEqual({});
	});

	test("parseEvents handles the real stream-json (init session_id, result usage)", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "init", session_id: "g-1", model: "auto" })}\n`,
			`${JSON.stringify({ type: "message", role: "assistant", content: "hi" })}\n`,
			`${JSON.stringify({ type: "result", status: "success", stats: { total_tokens: 14341 } })}\n`,
		]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(3);
		expect(events[0]?.sessionId).toBe("g-1");
		expect(events[2]?.usage).toEqual({ tokens: 14341, costUsd: 0 });
		expect(events[2]?.error).toBeUndefined();
	});

	test("parseEvents surfaces a failed result status as an error", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "result", status: "error", error: "quota exceeded" })}\n`,
		]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);
		expect(events[0]?.error).toContain("quota exceeded");
	});

	test("parseEvents skips blank/malformed lines", async () => {
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(streamFromChunks(["\n", "not json\n"]))) {
			events.push(ev);
		}
		expect(events).toHaveLength(0);
	});
});

describe("CursorRuntime", () => {
	const runtime = new CursorRuntime();

	test("metadata", () => {
		expect(runtime.id).toBe("cursor");
		expect(runtime.stability).toBe("beta");
		expect(runtime.instructionPath).toBe("AGENTS.md");
	});

	test("buildDirectSpawn invokes the `cursor-agent` binary with stream-json + --force", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ prompt: "do it", model: "gpt-5" }));
		expect(argv.slice(0, 3)).toEqual(["cursor-agent", "-p", "do it"]);
		expect(argv).toContain("--output-format");
		expect(argv).toContain("stream-json");
		expect(argv).toContain("--model");
		expect(argv).toContain("gpt-5");
		expect(argv).toContain("--force");
		expect(argv).not.toContain("--resume"); // no resume on the first turn
	});

	test("buildDirectSpawn adds --resume <id> on a follow-up turn", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ resumeSessionId: "chat-1" }));
		const idx = argv.indexOf("--resume");
		expect(idx).toBeGreaterThan(-1);
		expect(argv[idx + 1]).toBe("chat-1");
	});

	test("buildDirectSpawn treats an empty resumeSessionId as no resume", () => {
		const argv = runtime.buildDirectSpawn(spawnOpts({ resumeSessionId: "" }));
		expect(argv).not.toContain("--resume");
	});

	test("buildInteractiveSpawn is an attended `cursor-agent --model` (no -p)", () => {
		const argv = runtime.buildInteractiveSpawn?.({ model: "gpt-5" });
		expect(argv).toEqual(["cursor-agent", "--model", "gpt-5"]);
		expect(argv).not.toContain("-p");
	});

	test("buildInteractiveSpawn appends a seed message as the trailing arg", () => {
		const argv = runtime.buildInteractiveSpawn?.({ model: "m", initialMessage: "build x" });
		expect(argv?.[argv.length - 1]).toBe("build x");
	});

	test("buildPrintCommand emits text output and appends model only when given", () => {
		expect(runtime.buildPrintCommand("hi")).toEqual([
			"cursor-agent",
			"-p",
			"hi",
			"--output-format",
			"text",
		]);
		const withModel = runtime.buildPrintCommand("hi", "gpt-5");
		expect(withModel).toContain("--model");
		expect(withModel).toContain("gpt-5");
	});

	test("buildEnv copies provider env and returns empty for subscription/OAuth login", () => {
		expect(runtime.buildEnv({ model: "m", env: { CURSOR_API_KEY: "k" } })).toEqual({
			CURSOR_API_KEY: "k",
		});
		expect(runtime.buildEnv({ model: "m" })).toEqual({});
	});

	test("parseEvents captures the chat id under any common key spelling", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "system", chat_id: "chat-9" })}\n`,
			`${JSON.stringify({ type: "result" })}\n`,
		]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(2);
		expect(events[0]?.sessionId).toBe("chat-9");
		expect(events[1]?.sessionId).toBeUndefined();
	});

	test("parseEvents lifts a tool_use name and skips malformed lines", async () => {
		const toolLine = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Edit" }] },
		});
		const stream = streamFromChunks(["\n", "not json\n", `${toolLine}\n`]);

		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events).toHaveLength(1);
		expect(events[0]?.tool).toBe("Edit");
	});

	test("parseEvents handles the real stream-json: tool_call name, usage, is_error", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" })}\n`,
			`${JSON.stringify({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "ls" } } } })}\n`,
			`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", usage: { inputTokens: 6, outputTokens: 90, cacheReadTokens: 100881 } })}\n`,
		]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);

		expect(events[0]?.sessionId).toBe("s-1");
		expect(events[1]?.tool).toBe("shell"); // shellToolCall → shell
		expect(events[2]?.usage).toEqual({ tokens: 96, costUsd: 0 }); // input + output
		expect(events[2]?.error).toBeUndefined();
	});

	test("parseEvents surfaces an is_error result as an error", async () => {
		const stream = streamFromChunks([
			`${JSON.stringify({ type: "result", is_error: true, result: "Authentication required" })}\n`,
		]);
		const events: AgentEvent[] = [];
		for await (const ev of runtime.parseEvents(stream)) events.push(ev);
		expect(events[0]?.error).toBe("Authentication required");
	});
});

describe("getRuntime / getRuntimeNames", () => {
	test("lists exactly the registered runtimes in order", () => {
		expect(getRuntimeNames()).toEqual(["claude", "codex", "gemini", "cursor", "opencode", "mock"]);
	});

	test("resolves claude by name", () => {
		expect(getRuntime("claude")).toBeInstanceOf(ClaudeRuntime);
	});

	test("resolves opencode by name", () => {
		expect(getRuntime("opencode")).toBeInstanceOf(OpenCodeRuntime);
	});

	test("resolves codex + gemini + cursor by name (subscription/OAuth runtimes)", () => {
		expect(getRuntime("codex")).toBeInstanceOf(CodexRuntime);
		expect(getRuntime("gemini")).toBeInstanceOf(GeminiRuntime);
		expect(getRuntime("cursor")).toBeInstanceOf(CursorRuntime);
	});

	test("resolves mock by name", () => {
		expect(getRuntime("mock")).toBeInstanceOf(MockRuntime);
	});

	test("returns a fresh instance on each call", () => {
		expect(getRuntime("claude")).not.toBe(getRuntime("claude"));
	});

	test("falls back to claude when no name is given", () => {
		expect(getRuntime()).toBeInstanceOf(ClaudeRuntime);
	});

	test("honors the fallback argument when name is omitted", () => {
		expect(getRuntime(undefined, "mock")).toBeInstanceOf(MockRuntime);
	});

	test("an explicit name takes precedence over the fallback", () => {
		expect(getRuntime("claude", "mock")).toBeInstanceOf(ClaudeRuntime);
	});

	test("throws ValidationError listing valid names on an unknown runtime", () => {
		expect(() => getRuntime("nope")).toThrow(ValidationError);
		try {
			getRuntime("nope");
			throw new Error("expected getRuntime to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ValidationError);
			expect((error as ValidationError).message).toContain("nope");
			expect((error as ValidationError).message).toContain("claude");
			expect((error as ValidationError).message).toContain("mock");
		}
	});

	test("an unknown fallback also throws ValidationError", () => {
		expect(() => getRuntime(undefined, "bogus")).toThrow(ValidationError);
	});
});
