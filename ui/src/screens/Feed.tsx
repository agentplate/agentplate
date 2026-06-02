// Live feed — terminal-style activity stream.
//
// Styled after the original agentplate `ap dashboard` Feed panel: a monospace
// stream on a dark background where each row is
//   <dim clock> <bold color-coded 5-char label> <agent (stable color)> <dim detail>
// Newest at the BOTTOM with auto-scroll, and a pulsing "live" dot. Driven by the
// WS snapshot (5s); falls back to a one-shot REST load when offline.
//
// The new theme.css does not ship the old .feed-* / .fl-* classes, so the
// terminal widget brings its own scoped <style> block + lib helpers
// (clock / agentColor) for the colored bits.

import { useEffect, useRef, useState } from "react";
import { getFeed } from "../api.ts";
import { IconActivity, PageIcon } from "../icons.tsx";
import { agentColor, clock } from "../lib.tsx";
import type { FeedItem } from "../types.ts";

const MAX_ROWS = 200;

/** Color a 5-char label by its event class (matches the terminal theme). */
function labelColor(label: string, level: string): string {
	if (level === "error") return "var(--err)";
	if (level === "warn") return "var(--warn)";
	if (label.startsWith("TOOL")) return "var(--info)";
	if (label.startsWith("MAIL") || label.startsWith("DISP") || label === "PROG ") return "var(--cyan)";
	if (label.startsWith("SESS") || label.startsWith("DONE") || label === "RSULT") return "var(--ok)";
	if (label === "SPAWN") return "var(--violet)";
	return "var(--text-faint)";
}

const TERM_CSS = `
.ap-feed-term {
	background: #08090b;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 14px 16px;
	height: calc(100vh - 220px);
	min-height: 320px;
	overflow-y: auto;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 12.5px;
	line-height: 1.7;
}
.ap-fl-row {
	display: flex;
	gap: 12px;
	white-space: pre;
	align-items: baseline;
}
.ap-fl-row:hover { background: rgba(255,255,255,0.025); }
.ap-fl-time { color: var(--text-faint); flex: none; }
.ap-fl-label { font-weight: 700; flex: none; }
.ap-fl-agent { flex: none; font-weight: 600; }
.ap-fl-text { color: var(--text-dim); white-space: pre-wrap; word-break: break-word; }
.ap-feed-empty { color: var(--text-faint); padding: 24px 0; }
.ap-live-dot {
	width: 9px; height: 9px; border-radius: 50%;
	display: inline-block; flex: none;
}
.ap-live-dot.on { background: var(--ok); animation: ap-pulse 1.4s ease-in-out infinite; }
.ap-live-dot.off { background: var(--text-faint); }
@keyframes ap-pulse {
	0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(52,211,153,0.5); }
	50% { opacity: 0.4; box-shadow: 0 0 0 5px rgba(52,211,153,0); }
}
`;

export function FeedScreen({ feed, live }: { feed: FeedItem[]; live: boolean }): JSX.Element {
	const [fallback, setFallback] = useState<FeedItem[] | null>(null);
	const viewportRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (live || feed.length > 0) return;
		let cancelled = false;
		getFeed()
			.then((data) => {
				if (!cancelled) setFallback(data);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [live, feed.length]);

	// The feed arrives newest-first; render oldest→newest (terminal order).
	const source = feed.length > 0 ? feed : (fallback ?? []);
	const rows = [...source].reverse().slice(-MAX_ROWS);

	// Auto-scroll to the bottom as new rows arrive (when already near the bottom).
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on row count change.
	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
		if (nearBottom) el.scrollTop = el.scrollHeight;
	}, [rows.length]);

	return (
		<div>
			<style>{TERM_CSS}</style>
			<div className="page-head">
				<div className="head-row">
					<div>
						<h1 className="page-title">
							<PageIcon icon={IconActivity} tone="ok" /> Activity
						</h1>
						<p className="page-sub">Live terminal stream of agent tool calls and mail across the swarm.</p>
					</div>
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<span className={`ap-live-dot ${live ? "on" : "off"}`} />
						<span className="dim mono" style={{ fontSize: 12 }}>
							{live ? "live · 5s" : "offline"}
						</span>
					</div>
				</div>
			</div>

			<div ref={viewportRef} className="ap-feed-term">
				{rows.length === 0 ? (
					<div className="ap-feed-empty">
						No recent events. Spawn an agent or chat with the coordinator.
					</div>
				) : (
					rows.map((e, i) => (
						<div className="ap-fl-row" key={`${e.ts}-${i}`}>
							<span className="ap-fl-time">{clock(e.ts)}</span>
							<span className="ap-fl-label" style={{ color: labelColor(e.label, e.level) }}>
								{e.label}
							</span>
							<span className="ap-fl-agent" style={{ color: agentColor(e.agent) }}>
								{e.agent.padEnd(15)}
							</span>
							<span className="ap-fl-text">{e.detail ? e.detail : e.summary}</span>
						</div>
					))
				)}
			</div>
		</div>
	);
}
