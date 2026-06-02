// Costs & Analytics — token usage and cost tracking across all agents.
// TenacitOS-inspired dark control-center: KPI row, daily cost line chart,
// and cost-by-agent bar chart. Polls /api/costs every 5s.

import { useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { IconActivity, IconCost, IconCosts, IconUsers, PageIcon } from "../icons.tsx";
import { Card, Stat, fmtNum } from "../lib.tsx";
import { getCosts } from "../api.ts";
import { usePolling } from "../usePolling.ts";

const ACCENT = "#f5402d";
const GRID = "#23252b";
const AXIS = "#5f6670";

type Range = "7" | "30" | "90";

const tooltipStyle = {
	background: "#141519",
	border: "1px solid #23252b",
	borderRadius: 9,
	color: "#e8eaed",
	fontSize: 12,
} as const;

const EMPTY_MSG = "No token/cost data captured yet — agents will populate this as they run.";

export function CostsScreen(): JSX.Element {
	const { data, error, loading } = usePolling(getCosts, 5000);
	const [range, setRange] = useState<Range>("7");

	const report = data;
	const hasData = report?.hasData ?? false;
	const totalTokens = report?.totalTokens ?? 0;
	const totalCostUsd = report?.totalCostUsd ?? 0;
	const byAgent = report?.byAgent ?? [];
	const daily = report?.daily ?? [];
	const agentCount = byAgent.length;
	const avgPerAgent = agentCount > 0 ? totalCostUsd / agentCount : 0;

	return (
		<div>
			<div className="page-head">
				<div className="head-row">
					<div>
						<h1 className="page-title">
							<PageIcon icon={IconCosts} tone="ok" /> Costs &amp; Analytics
						</h1>
						<p className="page-sub">Token usage and cost tracking across all agents</p>
					</div>
					<div className="seg">
						<button
							type="button"
							className={range === "7" ? "active" : ""}
							onClick={() => setRange("7")}
						>
							7 days
						</button>
						<button
							type="button"
							className={range === "30" ? "active" : ""}
							onClick={() => setRange("30")}
						>
							30 days
						</button>
						<button
							type="button"
							className={range === "90" ? "active" : ""}
							onClick={() => setRange("90")}
						>
							90 days
						</button>
					</div>
				</div>
			</div>

			{error ? <div className="empty">Failed to load costs: {error}</div> : null}

			<div className="stat-grid">
				<Stat
					label="Total Tokens"
					value={fmtNum(totalTokens)}
					icon={<IconActivity size={20} />}
					iconTone="info"
					sub="all agents"
				/>
				<Stat
					label="Total Cost"
					value={`$${totalCostUsd.toFixed(2)}`}
					icon={<IconCost size={20} />}
					iconTone="ok"
					valueClass="sm"
					sub="USD"
				/>
				<Stat
					label="Agents"
					value={fmtNum(agentCount)}
					icon={<IconUsers size={20} />}
					iconTone="violet"
					sub="with usage"
				/>
				<Stat
					label="Avg / Agent"
					value={`$${avgPerAgent.toFixed(2)}`}
					icon={<IconCost size={20} />}
					iconTone="accent"
					valueClass="sm"
					sub="USD per agent"
				/>
			</div>

			<div className="row-2col">
				<Card title="Daily Cost Trend" meta={loading ? "loading…" : `${daily.length} days`}>
					{hasData && daily.length > 0 ? (
						<ResponsiveContainer width="100%" height={260}>
							<LineChart data={daily} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
								<CartesianGrid stroke={GRID} strokeDasharray="3 3" />
								<XAxis dataKey="date" tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
								<YAxis tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
								<Tooltip
									contentStyle={tooltipStyle}
									labelStyle={{ color: "#9aa0a8" }}
									cursor={{ stroke: GRID }}
									formatter={(v) => [`$${Number(v).toFixed(2)}`, "cost"]}
								/>
								<Line
									type="monotone"
									dataKey="costUsd"
									stroke={ACCENT}
									strokeWidth={2}
									dot={{ r: 2, fill: ACCENT }}
									activeDot={{ r: 4 }}
								/>
							</LineChart>
						</ResponsiveContainer>
					) : (
						<div className="empty">{EMPTY_MSG}</div>
					)}
				</Card>

				<Card title="Cost by Agent" meta={loading ? "loading…" : `${byAgent.length} agents`}>
					{hasData && byAgent.length > 0 ? (
						<ResponsiveContainer width="100%" height={260}>
							<BarChart data={byAgent} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
								<CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
								<XAxis dataKey="agent" tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
								<YAxis tick={{ fill: AXIS, fontSize: 11 }} stroke={GRID} />
								<Tooltip
									contentStyle={tooltipStyle}
									labelStyle={{ color: "#9aa0a8" }}
									cursor={{ fill: "rgba(245,64,45,0.08)" }}
									formatter={(v) => [`$${Number(v).toFixed(2)}`, "cost"]}
								/>
								<Bar dataKey="costUsd" fill={ACCENT} radius={[4, 4, 0, 0]} />
							</BarChart>
						</ResponsiveContainer>
					) : (
						<div className="empty">{EMPTY_MSG}</div>
					)}
				</Card>
			</div>
		</div>
	);
}
