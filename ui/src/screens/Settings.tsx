// Read-only settings / about screen for the Agentplate web UI.

import type { ReactNode } from "react";
import type { Overview } from "../types.ts";
import { IconSettings, PageIcon } from "../icons.tsx";
import { Badge, Card } from "../lib.tsx";

function Row({ k, value }: { k: string; value: ReactNode }): JSX.Element {
	return (
		<tr>
			<td className="dim nowrap">{k}</td>
			<td className="mono">{value}</td>
		</tr>
	);
}

export function SettingsScreen({ overview }: { overview: Overview | null }): JSX.Element {
	return (
		<div>
			<div className="page-head">
				<div className="page-title">
					<PageIcon icon={IconSettings} tone="info" /> Settings
				</div>
				<div className="page-sub">Project configuration (read-only)</div>
			</div>

			<div className="row-2col">
				<Card title="Project">
					<div className="grid-wrap">
						<table className="grid">
							<tbody>
								<Row k="Project" value={overview?.project ?? "—"} />
								<Row k="Runtime" value={overview?.runtime ?? "—"} />
								<Row k="Provider" value={overview?.provider ?? "—"} />
								{overview?.authMode != null && (
									<Row k="Auth" value={overview.authMode} />
								)}
								<Row k="Model" value={overview?.model ?? "—"} />
								{overview?.baseUrl != null && (
									<Row k="Base URL" value={overview.baseUrl} />
								)}
								<Row
									k="Deploy target"
									value={overview?.deployTarget ?? "(none)"}
								/>
								<Row k="Current run" value={overview?.currentRun?.id ?? "—"} />
								<Row
									k="Agents"
									value={
										overview ? (
											<Badge tone="accent">{overview.agentCount}</Badge>
										) : (
											"—"
										)
									}
								/>
							</tbody>
						</table>
					</div>
				</Card>

				<Card title="About">
					<p className="dim" style={{ lineHeight: 1.6, margin: "0 0 12px" }}>
						<strong style={{ color: "var(--accent)" }}>Agentplate</strong> is a
						self-improving multi-agent orchestration system that takes work from
						build to deploy. A single session becomes a coordinated team of agents
						running in isolated git worktrees, messaging through a SQLite mail bus
						and merging back with tiered conflict resolution.
					</p>
					<p className="dim" style={{ lineHeight: 1.6, margin: "0 0 12px" }}>
						Operate the swarm through the <span className="mono">agentplate</span>{" "}
						CLI, the live TUI dashboard, or this web UI.
					</p>
					<p className="faint" style={{ lineHeight: 1.6, margin: 0 }}>
						Edit <span className="mono">.agentplate/config.yaml</span> or run{" "}
						<span className="mono">agentplate setup</span> to change settings.
					</p>
				</Card>
			</div>
		</div>
	);
}
