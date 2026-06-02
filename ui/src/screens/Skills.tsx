// Skills screen — the self-improving skill library.
//
// Table of distilled skills: title + goal, a status badge, confidence rendered
// as a bar/percent, and applied/success counts. Polls GET /api/skills.

import { Badge, Card, Stat } from "../lib.tsx";
import type { BadgeTone } from "../lib.tsx";
import { IconActive, IconSkills, IconTarget, PageIcon } from "../icons.tsx";
import type { SkillSummary } from "../types.ts";
import { getSkills } from "../api.ts";
import { usePolling } from "../usePolling.ts";

function statusTone(status: string): BadgeTone {
	if (status === "active") return "ok";
	if (status === "quarantined") return "warn";
	return "neutral"; // deprecated / unknown
}

export function SkillsScreen(): JSX.Element {
	const { data, error, loading } = usePolling<SkillSummary[]>(getSkills, 5000);
	const skills = data ?? [];

	const active = skills.filter((s) => s.status === "active").length;
	const avgConfidence =
		skills.length > 0 ? skills.reduce((sum, s) => sum + s.confidence, 0) / skills.length : 0;

	return (
		<div>
			<div className="page-head">
				<h1 className="page-title">
					<PageIcon icon={IconSkills} tone="violet" /> Skills
				</h1>
				<p className="page-sub">Distilled, self-improving expertise ranked by confidence.</p>
			</div>

			{error ? (
				<Card>
					<span className="badge err">{error}</span>
				</Card>
			) : null}

			<div className="stat-grid">
				<Stat
					label="Total skills"
					value={skills.length}
					icon={<IconSkills size={20} />}
					iconTone="violet"
				/>
				<Stat
					label="Active"
					value={active}
					icon={<IconActive size={20} />}
					iconTone="accent"
					valueClass="accent"
				/>
				<Stat
					label="Avg confidence"
					value={`${Math.round(avgConfidence * 100)}%`}
					icon={<IconTarget size={20} />}
					iconTone="ok"
					valueClass="sm"
				/>
			</div>

			<Card
				title="Skill library"
				meta={`${skills.length} skill${skills.length === 1 ? "" : "s"}`}
			>
				<div className="grid-wrap">
					<table className="grid">
						<thead>
							<tr>
								<th>Skill</th>
								<th>Status</th>
								<th>Confidence</th>
								<th>Applied</th>
								<th>Success</th>
								<th>Ver</th>
							</tr>
						</thead>
						<tbody>
							{loading && skills.length === 0 ? (
								<tr>
									<td colSpan={6} className="empty">
										Loading skills…
									</td>
								</tr>
							) : skills.length === 0 ? (
								<tr>
									<td colSpan={6} className="empty">
										No skills distilled yet.
									</td>
								</tr>
							) : (
								skills.map((s) => {
									const pct = Math.max(0, Math.min(100, Math.round(s.confidence * 100)));
									return (
										<tr key={s.slug}>
											<td>
												<strong>{s.title || s.slug}</strong>
												{s.goal ? (
													<div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
														{s.goal}
													</div>
												) : null}
											</td>
											<td>
												<Badge tone={statusTone(s.status)}>{s.status}</Badge>
											</td>
											<td>
												<div
													style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 130 }}
												>
													<div className="bar" style={{ flex: 1 }}>
														<span style={{ width: `${pct}%` }} />
													</div>
													<span className="mono dim nowrap" style={{ fontSize: 12 }}>
														{pct}%
													</span>
												</div>
											</td>
											<td className="dim">{s.appliedCount}</td>
											<td className="dim">{Math.round(s.successCount * 100) / 100}</td>
											<td className="dim mono">v{s.version}</td>
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
