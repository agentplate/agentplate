/**
 * `agentplate spec` — author and read the task specs that drive dispatch.
 *
 * A spec is the **contract** a dispatcher hands a lead/worker: the per-task WHAT
 * (goal, scope, constraints, acceptance criteria, the branch to work from, …).
 * It lives as markdown at `.agentplate/specs/<taskId>.md` and is loaded into the
 * agent's task **at launch** via `agentplate sling --spec`. This is the only
 * race-free channel for a contract: mailing a brief after `sling` arrives after
 * the agent has already read its inbox once and started.
 *
 * Authoring a spec is a **dispatch action**, not implementation — it writes a
 * dispatch input under `.agentplate/specs/`, never the codebase. The coordinator
 * (which must not touch the work product) uses this freely.
 *
 *   write <taskId>   — write/overwrite the spec (body from --stdin | --body | --file)
 *   show  <taskId>   — print a spec (NotFoundError if absent)
 *   list             — list task ids that have a spec
 *   path  <taskId>   — print the resolved spec path (for scripting / --spec)
 *
 * `--json` is read via `command.optsWithGlobals().json === true`, matching the
 * house pattern in `skill.ts` / `mail.ts`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { findProjectRoot, isInitialized } from "../config.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { jsonOutput } from "../json.ts";
import { brand, muted, printSuccess } from "../logging/color.ts";
import { specPath, specsDir } from "../paths.ts";

/** Resolve the project root, throwing if Agentplate is not initialized there. */
function requireInit(): string {
	const root = findProjectRoot();
	if (!isInitialized(root)) {
		throw new ValidationError("Not initialized. Run `agentplate setup` first.");
	}
	return root;
}

/** Read the `--json` global flag off the action's trailing Command instance. */
function wantsJson(command: Command): boolean {
	return command.optsWithGlobals().json === true;
}

interface WriteOptions {
	stdin?: boolean;
	body?: string;
	file?: string;
	json?: boolean;
}

/**
 * Resolve the spec body from exactly one source. Exported for direct unit tests
 * (so we don't need a real stdin to assert the precedence + validation rules).
 */
export async function resolveSpecBody(
	opts: Pick<WriteOptions, "stdin" | "body" | "file">,
	readStdin: () => Promise<string> = () => Bun.stdin.text(),
): Promise<string> {
	const provided = [opts.stdin === true, opts.body != null, opts.file != null].filter(
		Boolean,
	).length;
	if (provided === 0) {
		throw new ValidationError(
			"spec write needs a body: pass one of --stdin, --body <text>, or --file <path>.",
		);
	}
	if (provided > 1) {
		throw new ValidationError("spec write takes exactly one of --stdin, --body, or --file.");
	}

	let body: string;
	if (opts.stdin) body = await readStdin();
	else if (opts.body != null) body = opts.body;
	else {
		const file = opts.file as string;
		if (!existsSync(file)) throw new ValidationError(`Spec source file not found: ${file}`);
		body = readFileSync(file, "utf8");
	}

	if (body.trim().length === 0) {
		throw new ValidationError("Refusing to write an empty spec — the contract would be blank.");
	}
	return body;
}

export async function runWrite(
	taskId: string,
	opts: WriteOptions,
	useJson: boolean,
): Promise<void> {
	const root = requireInit();
	const body = await resolveSpecBody(opts);
	const dir = specsDir(root);
	mkdirSync(dir, { recursive: true });
	const path = specPath(root, taskId);
	const existed = existsSync(path);
	const normalized = body.endsWith("\n") ? body : `${body}\n`;
	writeFileSync(path, normalized, "utf8");

	if (useJson) jsonOutput({ taskId, path, action: existed ? "updated" : "created" });
	else printSuccess(`Spec ${existed ? "updated" : "created"}: ${muted(path)}`);
}

export function runShow(taskId: string, useJson: boolean): void {
	const root = requireInit();
	const path = specPath(root, taskId);
	if (!existsSync(path)) {
		throw new NotFoundError(`No spec for "${taskId}" (expected ${path}).`);
	}
	const body = readFileSync(path, "utf8");
	if (useJson) jsonOutput({ taskId, path, body });
	else process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
}

export function runList(useJson: boolean): void {
	const root = requireInit();
	const dir = specsDir(root);
	const taskIds = existsSync(dir)
		? readdirSync(dir)
				.filter((f) => f.endsWith(".md"))
				.map((f) => f.slice(0, -3))
				.sort()
		: [];
	if (useJson) {
		jsonOutput(taskIds.map((taskId) => ({ taskId, path: specPath(root, taskId) })));
		return;
	}
	if (taskIds.length === 0) {
		process.stdout.write(`${muted("No specs yet.")}\n`);
		return;
	}
	for (const taskId of taskIds) process.stdout.write(`${brand(taskId)}\n`);
}

export function runPath(taskId: string, useJson: boolean): void {
	const root = requireInit();
	const path = specPath(root, taskId);
	if (useJson) jsonOutput({ taskId, path });
	else process.stdout.write(`${path}\n`);
}

function writeCommand(): Command {
	return new Command("write")
		.description("Write (or overwrite) a task spec — the dispatch contract")
		.argument("<task-id>", "task identifier")
		.option("--stdin", "read the spec body from stdin")
		.option("--body <text>", "spec body as an inline string")
		.option("--file <path>", "read the spec body from a file")
		.option("--json", "output JSON")
		.action((taskId: string, opts: WriteOptions, command: Command) =>
			runWrite(taskId, opts, wantsJson(command)),
		);
}

function showCommand(): Command {
	return new Command("show")
		.description("Print a task spec")
		.argument("<task-id>", "task identifier")
		.option("--json", "output JSON")
		.action((taskId: string, _opts: { json?: boolean }, command: Command) =>
			runShow(taskId, wantsJson(command)),
		);
}

function listCommand(): Command {
	return new Command("list")
		.description("List task ids that have a spec")
		.option("--json", "output JSON")
		.action((_opts: { json?: boolean }, command: Command) => runList(wantsJson(command)));
}

function pathCommand(): Command {
	return new Command("path")
		.description("Print the resolved spec path for a task id")
		.argument("<task-id>", "task identifier")
		.option("--json", "output JSON")
		.action((taskId: string, _opts: { json?: boolean }, command: Command) =>
			runPath(taskId, wantsJson(command)),
		);
}

/** Build the `agentplate spec` command tree. */
export function createSpecCommand(): Command {
	return new Command("spec")
		.description("Author and read task specs (the dispatch contract)")
		.addCommand(writeCommand())
		.addCommand(showCommand())
		.addCommand(listCommand())
		.addCommand(pathCommand());
}
