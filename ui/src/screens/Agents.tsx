// Agents grid + status board — every agent in the current run, click for detail.

import type { JSX } from "react";
import {
	IconActive,
	IconAgents,
	IconCompleted,
	IconChild,
	IconError,
	IconIdle,
	PageIcon,
} from "../icons.tsx";
import { agentColor, Badge, Stat, stateTone } from "../lib.tsx";
import type { AgentSession, StatusCounts } from "../types.ts";

export function AgentsScreen({
	agents,
	counts,
	onSelect,
}: {
	agents: AgentSession[];
	counts: StatusCounts;
	onSelect: (name: string) => void;
}): JSX.Element {
	return (
		<div>
			<div className="page-head">
				<div className="page-title">
					<PageIcon icon={IconAgents} /> Agents
				</div>
				<div className="page-sub">Every agent in the current run — click for detail</div>
			</div>

			<div className="stat-grid">
				<Stat
					label="Working"
					value={counts.working}
					icon={<IconActive size={20} />}
					iconTone="accent"
					valueClass="mono"
					sub="active now"
				/>
				<Stat
					label="Idle"
					value={counts.idle}
					icon={<IconIdle size={20} />}
					iconTone="info"
					valueClass="mono"
					sub="awaiting work"
				/>
				<Stat
					label="Completed"
					value={counts.completed}
					icon={<IconCompleted size={20} />}
					iconTone="ok"
					valueClass="mono"
					sub="finished"
				/>
				<Stat
					label="Stalled"
					value={counts.stalled}
					icon={<IconError size={20} />}
					iconTone="warn"
					valueClass="mono"
					sub="no recent activity"
				/>
			</div>

			{agents.length === 0 ? (
				<div className="empty">No agents in the current run.</div>
			) : (
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
						gap: 14,
					}}
				>
					{agents.map((a) => {
						const color = agentColor(a.agentName);
						const tone = stateTone(a.state);
						return (
							<div
								key={a.id}
								className="card row-click"
								style={{ borderLeft: `3px solid ${color}` }}
								onClick={() => onSelect(a.agentName)}
							>
								<div className="row-2col" style={{ marginBottom: 8 }}>
									<span style={{ fontWeight: 700, color }}>{a.agentName}</span>
									<Badge tone={tone.tone}>{tone.label}</Badge>
								</div>
								<div className="dim" style={{ marginBottom: 6 }}>
									{a.capability} · depth {a.depth}
								</div>
								<div className="mono dim nowrap" style={{ marginBottom: 4 }}>
									task: {a.taskId || "—"}
								</div>
								<div className="mono dim nowrap">branch: {a.branchName || "—"}</div>
								{a.parentAgent ? (
									<div
										className="faint mono nowrap"
										style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5 }}
									>
										<IconChild size={13} /> {a.parentAgent}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
