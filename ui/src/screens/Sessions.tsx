// Runs & Sessions history — every agent run and the sessions within it.
// TenacitOS "Session History" mirror: KPI row + a sortable, filterable table.

import { useMemo, useState } from "react";
import { getAgents, getRuns } from "../api.ts";
import { IconActive, IconLayers, IconRuns, IconSkills, PageIcon } from "../icons.tsx";
import { Badge, Card, Stat, fmtAgo, stateTone } from "../lib.tsx";
import type { AgentSession } from "../types.ts";
import { usePolling } from "../usePolling.ts";

/** Short, eye-readable run id (last segment / first 8 chars). */
function shortRun(runId: string): string {
	if (!runId) return "—";
	const tail = runId.includes("-") ? runId.slice(runId.lastIndexOf("-") + 1) : runId;
	return tail.length > 8 ? tail.slice(0, 8) : tail;
}

const ACTIVE_STATES = new Set(["working", "booting"]);

export function SessionsScreen({ onSelect }: { onSelect: (name: string) => void }): JSX.Element {
	const { data: runs } = usePolling(getRuns, 5000);
	const { data: agents } = usePolling(getAgents, 5000);

	const [filter, setFilter] = useState<string>("all");

	const runList = runs ?? [];
	const agentList = agents ?? [];

	const capabilities = useMemo(() => {
		const set = new Set<string>();
		for (const a of agentList) if (a.capability) set.add(a.capability);
		return Array.from(set).sort();
	}, [agentList]);

	const activeCount = useMemo(
		() => agentList.filter((a) => ACTIVE_STATES.has(a.state)).length,
		[agentList],
	);

	const sorted = useMemo(() => {
		const filtered =
			filter === "all" ? agentList : agentList.filter((a) => a.capability === filter);
		return [...filtered].sort(
			(a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
		);
	}, [agentList, filter]);

	return (
		<div>
			<div className="page-head">
				<h1 className="page-title">
					<PageIcon icon={IconRuns} tone="cyan" /> Runs &amp; Sessions
				</h1>
				<p className="page-sub">All agent runs and the sessions within them</p>
			</div>

			<div className="stat-grid">
				<Stat label="Total Runs" value={runList.length} icon={<IconRuns size={20} />} iconTone="cyan" />
				<Stat
					label="Total Sessions"
					value={agentList.length}
					icon={<IconLayers size={20} />}
					iconTone="info"
				/>
				<Stat
					label="Active"
					value={activeCount}
					icon={<IconActive size={20} />}
					iconTone="accent"
					valueClass={activeCount > 0 ? "" : "dim"}
					sub={`${activeCount} working / booting`}
				/>
				<Stat
					label="Capabilities"
					value={capabilities.length}
					icon={<IconSkills size={20} />}
					iconTone="violet"
				/>
			</div>

			<Card
				title="Sessions"
				right={
					capabilities.length > 0 ? (
						<div className="seg">
							<button
								type="button"
								className={filter === "all" ? "active" : ""}
								onClick={() => setFilter("all")}
							>
								All
							</button>
							{capabilities.map((cap) => (
								<button
									key={cap}
									type="button"
									className={filter === cap ? "active" : ""}
									onClick={() => setFilter(cap)}
								>
									{cap}
								</button>
							))}
						</div>
					) : (
						<span className="card-meta">{agentList.length} total</span>
					)
				}
			>
				<div className="grid-wrap">
					<table className="grid">
						<thead>
							<tr>
								<th>Session</th>
								<th>Capability</th>
								<th>State</th>
								<th>Task</th>
								<th>Run</th>
								<th>Updated</th>
							</tr>
						</thead>
						<tbody>
							{sorted.length === 0 ? (
								<tr>
									<td colSpan={6}>
										<div className="empty">No sessions to show.</div>
									</td>
								</tr>
							) : (
								sorted.map((a: AgentSession) => {
									const st = stateTone(a.state);
									return (
										<tr key={a.id} className="row-click" onClick={() => onSelect(a.agentName)}>
											<td>
												<span style={{ fontWeight: 700 }}>{a.agentName}</span>{" "}
												<Badge tone="neutral">{a.capability}</Badge>
											</td>
											<td className="dim">{a.capability}</td>
											<td>
												<Badge tone={st.tone}>{st.label}</Badge>
											</td>
											<td className="mono nowrap">{a.taskId || "—"}</td>
											<td className="mono nowrap faint">{shortRun(a.runId)}</td>
											<td className="dim nowrap">{fmtAgo(a.lastActivity)}</td>
										</tr>
									);
								})
							)}
						</tbody>
					</table>
				</div>
			</Card>
		</div>
	);
}
