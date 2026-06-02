// Deploy screen — registered deploy targets + the deploy audit history.
//
// Targets show id/label/stability and a compact capability summary. History is
// the append-only audit log: target, env, action, status, dry-run, time. Polls
// GET /api/deploy/targets and GET /api/deploy/history.

import { getDeployHistory, getDeployTargets } from "../api.ts";
import { Badge, Card, fmtAgo } from "../lib.tsx";
import type { BadgeTone } from "../lib.tsx";
import { IconArrowRight, IconCheck, IconDeploy, PageIcon } from "../icons.tsx";
import type { DeployAuditRow, DeployTargetSummary } from "../types.ts";
import { usePolling } from "../usePolling.ts";

function stabilityTone(stability: string): BadgeTone {
	if (stability === "stable") return "ok";
	if (stability === "beta") return "info";
	if (stability === "experimental") return "warn";
	return "neutral";
}

function statusTone(status: string): BadgeTone {
	if (status === "success") return "ok";
	if (status === "failed") return "err";
	return "neutral";
}

function shortSha(sha: string): string {
	return sha ? sha.slice(0, 7) : "—";
}

export function DeployScreen(): JSX.Element {
	const targets = usePolling<DeployTargetSummary[]>(getDeployTargets, 5000);
	const history = usePolling<DeployAuditRow[]>(getDeployHistory, 5000);

	const targetList = targets.data ?? [];
	const historyList = history.data ?? [];

	return (
		<div>
			<div className="page-head">
				<h1 className="page-title">
					<PageIcon icon={IconDeploy} /> Deploy
				</h1>
				<p className="page-sub">
					Build <IconArrowRight size={13} style={{ verticalAlign: "-2px" }} /> CI/CD{" "}
					<IconArrowRight size={13} style={{ verticalAlign: "-2px" }} /> deploy targets and the
					append-only audit trail.
				</p>
			</div>

			{targets.error ? (
				<Card>
					<span className="badge err">{targets.error}</span>
				</Card>
			) : null}

			<Card title="Targets" meta={`${targetList.length} registered`}>
				<div className="grid-wrap">
					<table className="grid">
						<thead>
							<tr>
								<th>Target</th>
								<th>Stability</th>
								<th>Environments</th>
								<th>Capabilities</th>
							</tr>
						</thead>
						<tbody>
							{targetList.length === 0 ? (
								<tr>
									<td colSpan={4} className="empty">
										No deploy targets registered.
									</td>
								</tr>
							) : (
								targetList.map((t) => (
									<tr key={t.id}>
										<td>
											<strong>{t.label}</strong>
											<div className="dim mono" style={{ fontSize: 11 }}>
												{t.id}
											</div>
											{t.description ? (
												<div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
													{t.description}
												</div>
											) : null}
										</td>
										<td>
											<Badge tone={stabilityTone(t.stability)}>{t.stability}</Badge>
										</td>
										<td className="dim">
											{t.caps.environments.length > 0 ? t.caps.environments.join(", ") : "—"}
										</td>
										<td>
											<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
												<Badge tone={t.caps.canRollback ? "ok" : "neutral"}>
													{t.caps.canRollback ? (
														<>
															<IconCheck size={12} /> rollback
														</>
													) : (
														"no rollback"
													)}
												</Badge>
												{t.caps.irreversible ? <Badge tone="err">irreversible</Badge> : null}
												<Badge tone={t.caps.requiresCredentials ? "warn" : "neutral"}>
													{t.caps.requiresCredentials ? "creds required" : "no creds"}
												</Badge>
											</div>
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</Card>

			{history.error ? (
				<Card>
					<span className="badge err">{history.error}</span>
				</Card>
			) : null}

			<div style={{ marginTop: 16 }}>
				<Card
					title="Deploy history"
					meta={`${historyList.length} record${historyList.length === 1 ? "" : "s"}`}
				>
					<div className="grid-wrap">
						<table className="grid">
							<thead>
								<tr>
									<th>Target</th>
									<th>Env</th>
									<th>Action</th>
									<th>Status</th>
									<th>Mode</th>
									<th>Commit</th>
									<th>When</th>
								</tr>
							</thead>
							<tbody>
								{history.loading && historyList.length === 0 ? (
									<tr>
										<td colSpan={7} className="empty">
											Loading history…
										</td>
									</tr>
								) : historyList.length === 0 ? (
									<tr>
										<td colSpan={7} className="empty">
											No deploys recorded yet.
										</td>
									</tr>
								) : (
									historyList.map((r) => (
										<tr key={r.id}>
											<td className="mono">{r.target}</td>
											<td className="dim">{r.environment}</td>
											<td className="dim">{r.action}</td>
											<td>
												<Badge tone={statusTone(r.status)}>{r.status}</Badge>
											</td>
											<td>
												{r.dryRun ? (
													<Badge tone="info">dry-run</Badge>
												) : (
													<Badge tone="accent">live</Badge>
												)}
											</td>
											<td className="mono dim">{shortSha(r.commitSha)}</td>
											<td className="dim nowrap">{fmtAgo(r.createdAt)}</td>
										</tr>
									))
								)}
							</tbody>
						</table>
					</div>
				</Card>
			</div>
		</div>
	);
}
