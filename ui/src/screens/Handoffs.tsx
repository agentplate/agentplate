// Handoffs screen — agent-to-agent work handoffs.
//
// Shows the protocol mail that moves work between roles (dispatch, worker_done,
// merge_ready, merged, escalation, deploy_*, …) as a from → to timeline, so an
// operator can audit who handed what to whom. Polls GET /api/handoffs every 5s.

import { getHandoffs } from "../api.ts";
import { Badge, Card, clock, fmtAgo } from "../lib.tsx";
import type { BadgeTone } from "../lib.tsx";
import { IconArrowRight, IconHandoffs, PageIcon } from "../icons.tsx";
import type { Handoff } from "../types.ts";
import { usePolling } from "../usePolling.ts";

/** Tone for a handoff type — completions ok, failures err, escalations warn. */
function handoffTone(type: string): BadgeTone {
	switch (type) {
		case "worker_done":
		case "merged":
		case "merge_ready":
		case "pipeline_ready":
		case "deploy_done":
		case "verify_done":
			return "ok";
		case "worker_died":
		case "merge_failed":
		case "deploy_failed":
		case "verify_failed":
			return "err";
		case "escalation":
		case "deploy_gate":
			return "warn";
		case "dispatch":
		case "assign":
			return "info";
		default:
			return "neutral";
	}
}

export function HandoffsScreen(): JSX.Element {
	const { data, error, loading } = usePolling<Handoff[]>(getHandoffs, 5000);
	const rows = data ?? [];

	return (
		<div>
			<div className="page-head">
				<h1 className="page-title">
					<PageIcon icon={IconHandoffs} tone="cyan" /> Handoffs
				</h1>
				<p className="page-sub">
					Work handed between agents — dispatches, completions, merges, escalations. Refreshes every
					5s.
				</p>
			</div>

			{error ? (
				<Card>
					<span className="badge err">{error}</span>
				</Card>
			) : null}

			<Card title="Agent handoffs" meta={loading ? "loading…" : `${rows.length} recent`}>
				<div className="grid-wrap">
					<table className="grid">
						<thead>
							<tr>
								<th>When</th>
								<th>Type</th>
								<th>From</th>
								<th />
								<th>To</th>
								<th>Subject</th>
							</tr>
						</thead>
						<tbody>
							{rows.length === 0 ? (
								<tr>
									<td colSpan={6} className="empty">
										No handoffs yet — agents will appear here as they coordinate.
									</td>
								</tr>
							) : (
								rows.map((h) => (
									<tr key={h.id}>
										<td className="dim nowrap" title={clock(h.createdAt)}>
											{fmtAgo(h.createdAt)}
										</td>
										<td>
											<Badge tone={handoffTone(h.type)}>{h.type}</Badge>
										</td>
										<td className="mono">{h.from}</td>
										<td className="faint nowrap">
											<IconArrowRight size={14} />
										</td>
										<td className="mono">{h.to}</td>
										<td className="dim">{h.subject}</td>
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
