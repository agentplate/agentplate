/**
 * `agentplate tui` / `agentplate dashboard` — a live terminal dashboard.
 *
 * A dependency-free 3-pane TUI (no Ink/blessed), repainting on an interval:
 *   ┌──────────────── Active agents (full width) ─────────────────┐
 *   ├──────────── Live feed ───────────┬──────── Tasks ───────────┤
 *   └──────────────────────────────────┴──────────────────────────┘
 * Reads the same stores the web UI uses, via the shared build* helpers.
 */

import { Command } from "commander";
import { findProjectRoot, isInitialized, loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { accent, brand, chalk, muted } from "../logging/color.ts";
import { sessionsDbPath } from "../paths.ts";
import { type ApiContext, buildFeed, buildTasks, resolveCurrentRunId } from "../serve/api.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, SessionState } from "../types.ts";

const STATE_COLOR: Record<SessionState, (s: string) => string> = {
	booting: chalk.yellow,
	working: chalk.green,
	idle: chalk.cyan,
	completed: chalk.blue,
	failed: chalk.red,
	stopped: muted,
};

const TASK_COLOR: Record<string, (s: string) => string> = {
	active: chalk.green,
	pending: chalk.cyan,
	done: chalk.blue,
	failed: chalk.red,
};

// --- text helpers -----------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes.
const ANSI = /\[[0-9;]*m/g;

/** Visible length, ignoring ANSI escape sequences. */
function visLen(s: string): number {
	return s.replace(ANSI, "").length;
}

/** Truncate to `width` visible chars. ANSI-styled input is flattened to plain. */
function clip(s: string, width: number): string {
	if (visLen(s) <= width) return s;
	const plain = s.replace(ANSI, "");
	return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

/** Pad a string (ANSI-aware) to exactly `width` visible chars. */
function pad(s: string, width: number): string {
	const clipped = clip(s, width);
	return clipped + " ".repeat(Math.max(0, width - visLen(clipped)));
}

// --- box drawing ------------------------------------------------------------

function topBorder(width: number, title: string): string {
	const t = ` ${title} `;
	const fill = "─".repeat(Math.max(0, width - 2 - visLen(t)));
	return muted("┌") + t + muted(`${fill}┐`);
}
function botBorder(width: number): string {
	return muted(`└${"─".repeat(Math.max(0, width - 2))}┘`);
}
function row(width: number, content: string): string {
	return `${muted("│")} ${pad(content, width - 4)} ${muted("│")}`;
}

// --- pane content -----------------------------------------------------------

function agentLine(s: AgentSession, width: number): string {
	const color = STATE_COLOR[s.state] ?? muted;
	const name = pad(s.agentName, 18);
	const cap = pad(s.capability, 11);
	const state = color(pad(s.state, 10));
	const task = muted(s.taskId);
	return clip(`${name} ${cap} ${state} ${task}`, width);
}

function render(root: string): string {
	const cols = Math.max(80, process.stdout.columns ?? 100);
	const width = cols - 1;
	const ctx: ApiContext = { root };
	const config = loadConfig(root);
	const store = createSessionStore(sessionsDbPath(root));

	try {
		const currentRunId = resolveCurrentRunId(store, root);
		const currentRun = currentRunId ? store.getRun(currentRunId) : null;
		const sessions = currentRunId ? store.listSessions({ runId: currentRunId }) : [];
		// Show ALL agents in the run, active first — agents spend most of their life
		// idle between turns, so filtering to working/booting made the pane look empty
		// even with a full team. Sort active → idle → done so live ones stay on top.
		const stateRank = (s: AgentSession): number =>
			s.state === "working" || s.state === "booting" ? 0 : s.state === "idle" ? 1 : 2;
		const agentsSorted = [...sessions].sort((a, b) => stateRank(a) - stateRank(b));
		const activeCount = sessions.filter(
			(s) => s.state === "working" || s.state === "booting",
		).length;
		const tasks = buildTasks(ctx);
		const feed = buildFeed(ctx, 40);

		const lines: string[] = [];

		// Header
		lines.push(
			`${brand("⚒ Agentplate")} ${muted("—")} ${config.project.name}  ${muted(
				`runtime ${config.runtime.default} · provider ${config.activeProvider} · ${
					currentRun ? currentRun.id : "no run"
				}`,
			)}`,
		);
		lines.push("");

		// ── Top pane: Agents (full width) — all agents in the run, active first ──
		lines.push(topBorder(width, accent(`Agents (${sessions.length} · ${activeCount} active)`)));
		if (agentsSorted.length === 0) {
			lines.push(row(width, muted("No agents yet. Spawn one with `agentplate sling <task>`.")));
		} else {
			for (const s of agentsSorted.slice(0, 8)) lines.push(row(width, agentLine(s, width - 4)));
			if (agentsSorted.length > 8)
				lines.push(row(width, muted(`…and ${agentsSorted.length - 8} more`)));
		}
		lines.push(botBorder(width));
		lines.push("");

		// ── Split: Live feed (left) | Tasks (right) ──
		const leftW = Math.floor((width - 1) * 0.58);
		const rightW = width - 1 - leftW;
		const bodyRows = Math.max(8, (process.stdout.rows ?? 30) - lines.length - 4);

		const feedLines = feed.slice(0, bodyRows).map((f) => {
			// Terminal-feed style: colored 5-char label + agent + summary.
			const labelColor =
				f.level === "error" ? chalk.red : f.level === "warn" ? chalk.yellow : chalk.cyan;
			return clip(`${labelColor(f.label)} ${muted(f.agent)} ${f.summary}`, leftW - 6);
		});
		const taskLines = tasks.slice(0, bodyRows).map((t) => {
			const color = TASK_COLOR[t.status] ?? muted;
			return `${color(pad(t.status, 8))} ${clip(t.taskId, rightW - 12)}`;
		});

		const paneRows = Math.max(feedLines.length, taskLines.length, 1);
		lines.push(
			`${topBorder(leftW, accent(`Live feed (${feed.length})`))}${topBorder(
				rightW,
				accent(`Tasks (${tasks.length})`),
			)}`,
		);
		for (let i = 0; i < paneRows; i++) {
			const l = feedLines[i] ?? (i === 0 && feed.length === 0 ? muted("No activity yet.") : "");
			const r = taskLines[i] ?? (i === 0 && tasks.length === 0 ? muted("No tasks yet.") : "");
			lines.push(`${row(leftW, l)}${row(rightW, r)}`);
		}
		lines.push(`${botBorder(leftW)}${botBorder(rightW)}`);

		lines.push("");
		lines.push(muted(`Updated ${new Date().toLocaleTimeString()} · refresh 5s · Ctrl+C to exit`));
		return lines.join("\n");
	} finally {
		store.close();
	}
}

export function createTuiCommand(): Command {
	return new Command("tui")
		.aliases(["dashboard"])
		.description("Live 3-pane terminal dashboard (agents / feed / tasks)")
		.option("--interval <ms>", "refresh interval", "5000")
		.option("--once", "render a single frame and exit")
		.action((opts: { interval: string; once?: boolean }) => {
			const root = findProjectRoot();
			if (!isInitialized(root)) {
				throw new ValidationError("Not initialized. Run `agentplate setup` first.");
			}

			const paint = () => {
				process.stdout.write("\x1b[2J\x1b[H");
				process.stdout.write(`${render(root)}\n`);
			};

			paint();
			if (opts.once) return;

			const interval = Math.max(1000, Number(opts.interval) || 5000);
			const timer = setInterval(paint, interval);
			const stop = () => {
				clearInterval(timer);
				process.stdout.write("\n");
				process.exit(0);
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
		});
}
