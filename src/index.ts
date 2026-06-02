#!/usr/bin/env bun

/**
 * Agentplate CLI — main entry point and command router.
 *
 * Usage: agentplate <command> [args...]   (alias: ap)
 *
 * Phase 0 wires the program shell, global flags, version handling, a consistent
 * top-level error handler, and the first real command (`doctor`). Subsequent
 * phases register their commands here.
 */

import { Command } from "commander";
import { createCoordinatorCommand } from "./commands/coordinator.ts";
import {
	createDeployCommand,
	createRollbackCommand,
	createTargetCommand,
} from "./commands/deploy.ts";
import { createDoctorCommand } from "./commands/doctor.ts";
import { createInitCommand } from "./commands/init.ts";
import { createLogCommand } from "./commands/log.ts";
import { createMailCommand } from "./commands/mail.ts";
import { createMergeCommand } from "./commands/merge.ts";
import { createModelCommand } from "./commands/model.ts";
import { createPrimeCommand } from "./commands/prime.ts";
import { createReapCommand } from "./commands/reap.ts";
import { createServeCommand } from "./commands/serve.ts";
import { createSetupCommand } from "./commands/setup.ts";
import { createShipCommand } from "./commands/ship.ts";
import { createSkillCommand } from "./commands/skill.ts";
import { createSlingCommand } from "./commands/sling.ts";
import { createSpecCommand } from "./commands/spec.ts";
import { createStatusCommand } from "./commands/status.ts";
import { createStopCommand } from "./commands/stop.ts";
import { createTuiCommand } from "./commands/tui.ts";
import { createWorktreeCommand } from "./commands/worktree.ts";
import { setProjectRootOverride } from "./config.ts";
import { isAgentplateError } from "./errors.ts";
import { jsonError } from "./json.ts";
import { brand, muted, printError, setQuiet } from "./logging/color.ts";
import { VERSION } from "./version.ts";

export { VERSION };

interface GlobalOptions {
	json?: boolean;
	verbose?: boolean;
	quiet?: boolean;
	project?: string;
}

const rawArgs = process.argv.slice(2);

// Handle `--version --json` before Commander consumes the flag.
if ((rawArgs.includes("-v") || rawArgs.includes("--version")) && rawArgs.includes("--json")) {
	process.stdout.write(
		`${JSON.stringify({
			name: "agentplate",
			version: VERSION,
			runtime: "bun",
			platform: `${process.platform}-${process.arch}`,
		})}\n`,
	);
	process.exit(0);
}

function buildProgram(): Command {
	const program = new Command();

	program
		.name("agentplate")
		.description(
			`${brand("Agentplate")} — self-improving multi-agent orchestration, from build to deploy.`,
		)
		.version(VERSION, "-v, --version", "output the version number")
		.option("--json", "output machine-readable JSON")
		.option("--verbose", "verbose output")
		.option("-q, --quiet", "suppress non-error output")
		.option("--project <path>", "target project root (overrides auto-detection)")
		.configureHelp({ showGlobalOptions: true });

	// Apply global flags before any subcommand action runs. optsWithGlobals()
	// merges the subcommand's options with the program's global options.
	program.hook("preAction", (thisCommand) => {
		const opts = thisCommand.optsWithGlobals<GlobalOptions>();
		if (opts.quiet) setQuiet(true);
		if (opts.project) setProjectRootOverride(opts.project);
	});

	// Onboarding
	program.addCommand(createSetupCommand());
	program.addCommand(createInitCommand());
	program.addCommand(createModelCommand());
	program.addCommand(createDoctorCommand());
	// Orchestration
	program.addCommand(createCoordinatorCommand());
	program.addCommand(createSlingCommand());
	program.addCommand(createSpecCommand());
	program.addCommand(createStatusCommand());
	program.addCommand(createMailCommand());
	program.addCommand(createMergeCommand());
	program.addCommand(createWorktreeCommand());
	program.addCommand(createStopCommand());
	program.addCommand(createReapCommand());
	program.addCommand(createPrimeCommand());
	program.addCommand(createLogCommand());
	// Self-improving skills
	program.addCommand(createSkillCommand());
	// Build → CI/CD → Deploy
	program.addCommand(createShipCommand());
	program.addCommand(createTargetCommand());
	program.addCommand(createDeployCommand());
	program.addCommand(createRollbackCommand());
	// Surfaces
	program.addCommand(createServeCommand());
	program.addCommand(createTuiCommand());

	program.addHelpText(
		"after",
		`\n${muted("More commands (ship, skill, deploy, …) arrive as Agentplate grows.")}`,
	);

	return program;
}

async function main(): Promise<void> {
	const program = buildProgram();
	await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
	if (rawArgs.includes("--json")) {
		jsonError(error);
	} else {
		printError(error instanceof Error ? error.message : String(error));
	}
	process.exit(isAgentplateError(error) ? error.exitCode : 1);
});
