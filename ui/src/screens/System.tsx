// System Monitor — real-time host metrics for the box running `ap serve`.

import { getSystem } from "../api.ts";
import { IconSystem, PageIcon } from "../icons.tsx";
import { Badge, Card, fmtBytes, fmtUptime } from "../lib.tsx";
import type { SystemMetrics } from "../types.ts";
import { usePolling } from "../usePolling.ts";

/** Threshold color: red >=90, amber >=70, else green. */
function thresholdColor(pct: number): string {
	if (pct >= 90) return "#f5402d";
	if (pct >= 70) return "#fbbf24";
	return "#34d399";
}

function ProgressBar({ pct }: { pct: number }): JSX.Element {
	const clamped = Math.max(0, Math.min(100, pct));
	return (
		<div className="bar" style={{ marginTop: 14 }}>
			<span style={{ width: `${clamped}%`, background: thresholdColor(pct) }} />
		</div>
	);
}

function BigPct({ pct }: { pct: number }): JSX.Element {
	return (
		<span
			className="mono"
			style={{ fontSize: 30, fontWeight: 700, color: thresholdColor(pct), lineHeight: 1 }}
		>
			{Math.round(pct)}
			<span style={{ fontSize: 18 }}>%</span>
		</span>
	);
}

export function SystemScreen(): JSX.Element {
	const { data, error, loading } = usePolling<SystemMetrics>(getSystem, 5000);

	return (
		<div>
			<div className="page-head">
				<div className="head-row">
					<div>
						<div className="page-title">
							<PageIcon icon={IconSystem} tone="info" /> System Monitor
						</div>
						<div className="page-sub">
							Real-time monitoring of the server running agentplate serve
						</div>
					</div>
					<Badge tone="ok">● Live</Badge>
				</div>
			</div>

			{loading && !data ? <div className="empty">Loading system metrics…</div> : null}
			{error ? <div className="empty">Failed to load system metrics: {error}</div> : null}

			{data ? <SystemBody m={data} /> : null}
		</div>
	);
}

function SystemBody({ m }: { m: SystemMetrics }): JSX.Element {
	const [l1, l5, l15] = m.cpu.loadAvg;
	const diskKnown = m.disk.percent != null && m.disk.usedBytes != null && m.disk.totalBytes != null;

	return (
		<div className="row-2col">
			<Card title="CPU" right={<span className="faint mono">{m.cpu.cores} cores</span>}>
				<div className="row-2col" style={{ alignItems: "center" }}>
					<BigPct pct={m.cpu.percent} />
					<div className="dim mono" style={{ fontSize: 12, textAlign: "right" }}>
						Load Average
						<br />
						{l1.toFixed(2)} / {l5.toFixed(2)} / {l15.toFixed(2)}
					</div>
				</div>
				<ProgressBar pct={m.cpu.percent} />
			</Card>

			<Card title="RAM">
				<div className="row-2col" style={{ alignItems: "center" }}>
					<BigPct pct={m.memory.percent} />
					<div className="dim mono" style={{ fontSize: 12, textAlign: "right" }}>
						{fmtBytes(m.memory.usedBytes)} / {fmtBytes(m.memory.totalBytes)}
					</div>
				</div>
				<ProgressBar pct={m.memory.percent} />
			</Card>

			<Card title="DISK">
				{diskKnown ? (
					<>
						<div className="row-2col" style={{ alignItems: "center" }}>
							<BigPct pct={m.disk.percent as number} />
							<div className="dim mono" style={{ fontSize: 12, textAlign: "right" }}>
								{fmtBytes(m.disk.usedBytes)} / {fmtBytes(m.disk.totalBytes)}
							</div>
						</div>
						<ProgressBar pct={m.disk.percent as number} />
					</>
				) : (
					<div className="empty">Disk metrics unavailable</div>
				)}
			</Card>

			<Card title="Host">
				<div className="row-2col" style={{ rowGap: 12 }}>
					<div>
						<div className="faint" style={{ fontSize: 11, textTransform: "uppercase" }}>
							Hostname
						</div>
						<div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>
							{m.hostname}
						</div>
					</div>
					<div>
						<div className="faint" style={{ fontSize: 11, textTransform: "uppercase" }}>
							Platform
						</div>
						<div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>
							{m.platform}
						</div>
					</div>
					<div>
						<div className="faint" style={{ fontSize: 11, textTransform: "uppercase" }}>
							Uptime
						</div>
						<div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>
							{fmtUptime(m.uptimeSeconds)}
						</div>
					</div>
				</div>
			</Card>
		</div>
	);
}
