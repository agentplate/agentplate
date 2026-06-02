// Shared helpers + tiny presentational components for the Agentplate OS UI.

import type { ReactNode } from "react";

/** Stable per-agent accent color (deterministic name hash). */
const AGENT_COLORS = [
	"#f5402d", // accent red
	"#34d399", // emerald
	"#fbbf24", // amber
	"#a78bfa", // violet
	"#f778ba", // pink
	"#22d3ee", // cyan
	"#ff8a3d", // orange
	"#60a5fa", // blue
];
export function agentColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return AGENT_COLORS[h % AGENT_COLORS.length] ?? "#9aa0a8";
}

/** HH:MM:SS local clock. */
export function clock(iso: string | null | undefined): string {
	if (!iso) return "--:--:--";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "--:--:--" : d.toLocaleTimeString(undefined, { hour12: false });
}

/** "x ago" relative time. */
export function fmtAgo(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	const s = Math.floor((Date.now() - d.getTime()) / 1000);
	if (s < 0) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** Compact bytes → "3.4 GB". */
export function fmtBytes(n: number | null): string {
	if (n == null) return "—";
	const u = ["B", "KB", "MB", "GB", "TB"];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Compact number → "27k". */
export function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
	return String(n);
}

/** Seconds → "3d 6h". */
export function fmtUptime(s: number): string {
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

export type BadgeTone = "ok" | "warn" | "err" | "info" | "accent" | "neutral" | "violet";

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }): JSX.Element {
	return <span className={`badge ${tone}`}>{children}</span>;
}

/** A KPI stat card (the dashboard's top row). */
export function Stat({
	label,
	value,
	icon,
	iconTone,
	sub,
	valueClass,
}: {
	label: string;
	value: ReactNode;
	icon?: ReactNode;
	/** Vibrant gradient tone for the icon chip (default: accent). */
	iconTone?: "accent" | "ok" | "warn" | "info" | "violet" | "cyan";
	sub?: ReactNode;
	valueClass?: string;
}): JSX.Element {
	return (
		<div className="stat">
			<div className="stat-top">
				<span className="stat-label">{label}</span>
				{icon ? <span className={`stat-icon ${iconTone ?? ""}`}>{icon}</span> : null}
			</div>
			<div className={`stat-value ${valueClass ?? ""}`}>{value}</div>
			{sub != null ? <div className="stat-sub">{sub}</div> : null}
		</div>
	);
}

/** A titled card/panel. */
export function Card({
	title,
	meta,
	children,
	right,
}: {
	title?: ReactNode;
	meta?: ReactNode;
	right?: ReactNode;
	children: ReactNode;
}): JSX.Element {
	return (
		<div className="card">
			{title != null || right != null ? (
				<div className="card-head">
					<span className="card-title">{title}</span>
					{right ?? (meta != null ? <span className="card-meta">{meta}</span> : null)}
				</div>
			) : null}
			{children}
		</div>
	);
}

/** Map an agent SessionState to a badge tone + label. */
export function stateTone(state: string): { tone: BadgeTone; label: string } {
	switch (state) {
		case "working":
		case "booting":
			return { tone: "ok", label: state };
		case "idle":
			return { tone: "info", label: "idle" };
		case "completed":
			return { tone: "accent", label: "completed" };
		case "failed":
			return { tone: "err", label: "failed" };
		default:
			return { tone: "neutral", label: state };
	}
}
