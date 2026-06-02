// Mission Control — the TenacitOS-inspired dashboard overview screen.
//
// KPI row (live counts) over a "Multi-Agent System" card that lays out every
// agent as a clickable, color-bordered tile.

import {
	IconActive,
	IconArrowRight,
	IconCompleted,
	IconDashboard,
	IconError,
	IconGame,
	IconNetwork,
	IconUsers,
	PageIcon,
} from "../icons.tsx";
import { Badge, Card, Stat, agentColor, stateTone } from "../lib.tsx";
import type { AgentSession, Overview, StatusCounts } from "../types.ts";

export function MissionControl({
	overview,
	agents,
	counts,
	onOpenOffice,
	onSelect,
}: {
	overview: Overview | null;
	agents: AgentSession[];
	counts: StatusCounts;
	onOpenOffice: () => void;
	onSelect: (name: string) => void;
}): JSX.Element {
	return (
		<div>
			<div className="page-head">
				<h1 className="page-title">
					<PageIcon icon={IconDashboard} /> Mission Control
				</h1>
				<p className="page-sub">Overview of agent activity</p>
			</div>

			<div className="stat-grid">
				<Stat
					label="Total Agents"
					value={agents.length}
					icon={<IconUsers size={20} />}
					iconTone="info"
					sub="all sessions"
				/>
				<Stat
					label="Active"
					value={counts.working}
					icon={<IconActive size={20} />}
					iconTone="accent"
					sub="working now"
					valueClass={counts.working > 0 ? "" : "sm"}
				/>
				<Stat
					label="Completed"
					value={counts.completed}
					icon={<IconCompleted size={20} />}
					iconTone="ok"
					sub="finished"
				/>
				<Stat
					label="Errors / Stalled"
					value={counts.stalled}
					icon={<IconError size={20} />}
					iconTone="warn"
					sub="needs attention"
				/>
			</div>

			<Card
				title={
					<>
						<IconNetwork size={18} /> Multi-Agent System
					</>
				}
				right={
					<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
						<button type="button" className="btn primary" onClick={onOpenOffice}>
							<IconGame size={15} /> Open Office
						</button>
						<button
							type="button"
							className="btn"
							onClick={onOpenOffice}
							style={{ background: "transparent", border: "none" }}
						>
							View all <IconArrowRight size={14} />
						</button>
					</div>
				}
			>
				{agents.length === 0 ? (
					<div className="empty">No active agents — spawn one to get started.</div>
				) : (
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
							gap: 14,
						}}
					>
						{agents.map((agent) => {
							const tone = stateTone(agent.state);
							const color = agentColor(agent.agentName);
							return (
								<button
									key={agent.id}
									type="button"
									onClick={() => onSelect(agent.agentName)}
									style={{
										textAlign: "left",
										cursor: "pointer",
										background: "var(--bg-card-2)",
										border: "1px solid var(--border-soft)",
										borderLeft: `3px solid ${color}`,
										borderRadius: "var(--radius-sm)",
										padding: "14px 16px",
										font: "inherit",
										color: "var(--text)",
										display: "flex",
										flexDirection: "column",
										gap: 8,
									}}
								>
									<div
										style={{
											fontWeight: 700,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										}}
									>
										{agent.agentName}
									</div>
									<div className="dim" style={{ fontSize: 12 }}>
										{overview?.model ?? agent.capability}
									</div>
									<div>
										<Badge tone={tone.tone}>
											<span className="bdot" />
											{tone.label}
										</Badge>
									</div>
								</button>
							);
						})}
					</div>
				)}
			</Card>
		</div>
	);
}

