// Tasks screen — the work queue.
//
// Each task is a unit of work (a spec + the agents on it), with a status rolled
// up from its agent sessions: pending → active → done / failed. Prefers the live
// WS snapshot's `tasks`, falling back to polling GET /api/tasks every 5s.

import { useEffect, useState } from "react";
import { getTasks } from "../api.ts";
import { IconActive, IconCheck, IconTasks, PageIcon } from "../icons.tsx";
import { Badge, Card, Stat, fmtAgo } from "../lib.tsx";
import type { BadgeTone } from "../lib.tsx";
import type { TaskItem } from "../types.ts";

function statusTone(status: string): BadgeTone {
	switch (status) {
		case "active":
			return "accent";
		case "done":
			return "ok";
		case "failed":
			return "err";
		case "pending":
			return "info";
		default:
			return "neutral";
	}
}

export function TasksScreen({ tasks, live }: { tasks: TaskItem[]; live: boolean }): JSX.Element {
	const [fallback, setFallback] = useState<TaskItem[] | null>(null);

	useEffect(() => {
		if (live || tasks.length > 0) return;
		let cancelled = false;
		getTasks()
			.then((data) => {
				if (!cancelled) setFallback(data);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [live, tasks.length]);

	const rows = tasks.length > 0 ? tasks : (fallback ?? []);
	const active = rows.filter((t) => t.status === "active").length;
	const done = rows.filter((t) => t.status === "done").length;

	return (
		<div>
			<div className="page-head">
				<h1 className="page-title">
					<PageIcon icon={IconTasks} tone="violet" /> Tasks
				</h1>
				<p className="page-sub">
					{live ? "Live work queue via WebSocket." : "Socket offline — last known tasks."} Refreshes
					every 5s.
				</p>
			</div>

			<div className="stat-grid">
				<Stat label="Total tasks" value={rows.length} icon={<IconTasks size={20} />} iconTone="violet" />
				<Stat
					label="Active"
					value={active}
					icon={<IconActive size={20} />}
					iconTone="accent"
					valueClass="accent"
				/>
				<Stat label="Done" value={done} icon={<IconCheck size={20} />} iconTone="ok" />
			</div>

			<Card title="Tasks" meta={`${rows.length} total · ${active} active · ${done} done`}>
				<div className="grid-wrap">
					<table className="grid">
						<thead>
							<tr>
								<th>Task</th>
								<th>Status</th>
								<th>Capabilities</th>
								<th>Agents</th>
								<th>Last activity</th>
							</tr>
						</thead>
						<tbody>
							{rows.length === 0 ? (
								<tr>
									<td colSpan={5} className="empty">
										No tasks yet. Submit one from the Chat tab.
									</td>
								</tr>
							) : (
								rows.map((t) => (
									<tr key={t.taskId}>
										<td>
											<strong className="mono">{t.taskId}</strong>
											{t.summary ? <div className="dim">{t.summary}</div> : null}
										</td>
										<td>
											<Badge tone={statusTone(t.status)}>{t.status}</Badge>
										</td>
										<td className="dim">
											{t.capabilities.length > 0 ? t.capabilities.join(", ") : "—"}
										</td>
										<td className="dim">
											{t.agentCount > 0 ? (
												<span title={t.agents.join(", ")}>
													{t.agentCount} ({t.agents.slice(0, 2).join(", ")}
													{t.agents.length > 2 ? "…" : ""})
												</span>
											) : (
												"—"
											)}
										</td>
										<td className="dim nowrap">{t.lastActivity ? fmtAgo(t.lastActivity) : "—"}</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</Card>
		</div>
	);
}
