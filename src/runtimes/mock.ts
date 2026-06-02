/**
 * Deterministic test runtime.
 *
 * The mock runtime exists so orchestration code (sling, turn-runner, merge) can
 * be exercised end-to-end without a real coding-agent CLL or any LLM cost. A
 * "turn" is just a scripted bash command: tests set `AGENTPLATE_MOCK_CMD` to make
 * the worker do something concrete inside its worktree (e.g. write a file and
 * `git commit`), then assert on the resulting branch. Because the script runs
 * via `bash -lc`, the env var can be an arbitrary shell snippet.
 *
 * It implements the same {@link AgentRuntime} contract as real adapters but is
 * marked `experimental` and is never selected by default — only when a caller
 * explicitly resolves `"mock"`.
 */

import type { ResolvedModel } from "../types.ts";
import type { AgentRuntime, DirectSpawnOpts, InteractiveSpawnOpts } from "./types.ts";

export class MockRuntime implements AgentRuntime {
	/** Registry id; tests resolve this explicitly via `getRuntime("mock")`. */
	readonly id = "mock";

	/** Test-only — never a production default. */
	readonly stability = "experimental" as const;

	/** Plain `CLAUDE.md` at the worktree root; the mock does not nest under `.claude/`. */
	readonly instructionPath = "CLAUDE.md";

	/**
	 * Build argv for one "turn" as a scripted bash command.
	 *
	 * The command body comes from `AGENTPLATE_MOCK_CMD` (default `true`, a no-op that
	 * exits 0), letting a test drive the worker's exact behavior — including
	 * writing files and committing inside the worktree the orchestrator created.
	 * `bash -lc` is used so the snippet runs as a normal login shell command with
	 * full access to PATH (git, etc.). The argv form keeps the snippet a single
	 * opaque argument — no second layer of shell interpolation by us.
	 *
	 * `opts` is part of the interface but unused: the mock's behavior is fully
	 * determined by the env var, which is what makes it deterministic.
	 */
	buildDirectSpawn(_opts: DirectSpawnOpts): string[] {
		return ["bash", "-lc", process.env.AGENTPLATE_MOCK_CMD ?? "true"];
	}

	/**
	 * Interactive session, scripted via `AGENTPLATE_MOCK_INTERACTIVE` (default
	 * `true`, an instant clean exit) so `coordinator start` tests never fork a real
	 * `claude`. `opts` is accepted for interface parity but ignored.
	 */
	buildInteractiveSpawn(_opts: InteractiveSpawnOpts): string[] {
		return ["bash", "-lc", process.env.AGENTPLATE_MOCK_INTERACTIVE ?? "true"];
	}

	/** Pass provider env through unchanged (a fresh copy), mirroring real adapters. */
	buildEnv(model: ResolvedModel): Record<string, string> {
		return { ...(model.env ?? {}) };
	}

	/**
	 * One-shot print command, scripted via `AGENTPLATE_MOCK_PRINT` (default
	 * `echo mock`). `prompt`/`model` are accepted for interface parity but ignored
	 * so the output stays deterministic for assertions.
	 */
	buildPrintCommand(_prompt: string, _model?: string): string[] {
		return ["bash", "-lc", process.env.AGENTPLATE_MOCK_PRINT ?? "echo mock"];
	}
}

/** Singleton for callers that do not need dependency injection. */
export const mockRuntime = new MockRuntime();
