// Notification center — the topbar bell.
//
// Surfaces the feed items that need an operator's attention: anything the
// server flagged warn or error (failed agents, merge/deploy failures,
// escalations). The bell shows an unread count; opening the panel marks the
// current items seen (persisted in localStorage so a reload doesn't re-alarm).
// Clicking a notification that names a known agent opens its detail drawer.

import { useEffect, useMemo, useRef, useState } from "react";
import { IconBell } from "./icons.tsx";
import { agentColor, fmtAgo } from "./lib.tsx";
import type { FeedItem } from "./types.ts";

const SEEN_KEY = "agentplate.notif.lastSeen";
const MAX_ITEMS = 40;

/** A feed item is notification-worthy when the server flagged it warn/error. */
function isNotable(f: FeedItem): boolean {
	return f.level === "warn" || f.level === "error";
}

/** Stable-ish identity for de-duping / ordering (feed items have no id). */
function keyOf(f: FeedItem): string {
	return `${f.ts}|${f.agent}|${f.label}|${f.summary}`;
}

function readLastSeen(): string {
	try {
		return window.localStorage.getItem(SEEN_KEY) ?? "";
	} catch {
		return "";
	}
}

function writeLastSeen(ts: string): void {
	try {
		window.localStorage.setItem(SEEN_KEY, ts);
	} catch {
		// localStorage may be unavailable (private mode) — non-fatal.
	}
}

export function NotificationBell({
	feed,
	agentNames,
	onSelectAgent,
}: {
	feed: FeedItem[];
	agentNames: Set<string>;
	onSelectAgent: (name: string) => void;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const [lastSeen, setLastSeen] = useState<string>(() => readLastSeen());
	const wrapRef = useRef<HTMLDivElement>(null);

	// Notable items, newest first (the feed already arrives newest-first).
	const items = useMemo(() => feed.filter(isNotable).slice(0, MAX_ITEMS), [feed]);

	const unread = useMemo(
		() => (lastSeen ? items.filter((f) => f.ts > lastSeen).length : items.length),
		[items, lastSeen],
	);

	// Mark everything currently visible as seen.
	function markSeen(): void {
		const newest = items[0]?.ts;
		if (newest && newest !== lastSeen) {
			setLastSeen(newest);
			writeLastSeen(newest);
		}
	}

	function toggle(): void {
		setOpen((v) => {
			const next = !v;
			if (next) markSeen();
			return next;
		});
	}

	// Close on outside click + Escape while open.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	function onItemClick(f: FeedItem): void {
		if (agentNames.has(f.agent)) {
			onSelectAgent(f.agent);
			setOpen(false);
		}
	}

	return (
		<div className="notif-wrap" ref={wrapRef}>
			<button
				type="button"
				className="topbar-icon"
				title="Notifications"
				aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
				aria-expanded={open}
				onClick={toggle}
			>
				<IconBell size={18} strokeWidth={2} />
				{unread > 0 ? <span className="topbar-badge">{unread > 9 ? "9+" : unread}</span> : null}
			</button>

			{open ? (
				<div className="notif-panel" role="dialog" aria-label="Notifications">
					<div className="notif-head">
						<span className="notif-title">Notifications</span>
						<span className="notif-count">{items.length ? `${items.length} recent` : "—"}</span>
					</div>
					{items.length === 0 ? (
						<div className="notif-empty">No alerts. All agents are healthy.</div>
					) : (
						<ul className="notif-list">
							{items.map((f) => {
								const clickable = agentNames.has(f.agent);
								return (
									<li
										key={keyOf(f)}
										className={`notif-item ${clickable ? "clickable" : ""} ${
											lastSeen && f.ts > lastSeen ? "fresh" : ""
										}`}
										onClick={clickable ? () => onItemClick(f) : undefined}
										onKeyDown={
											clickable
												? (e) => {
														if (e.key === "Enter") onItemClick(f);
													}
												: undefined
										}
										role={clickable ? "button" : undefined}
										tabIndex={clickable ? 0 : undefined}
									>
										<span
											className="notif-dot"
											style={{ background: f.level === "error" ? "var(--err)" : "var(--warn)" }}
										/>
										<div className="notif-body">
											<div className="notif-row1">
												<span className="notif-agent" style={{ color: agentColor(f.agent) }}>
													{f.agent}
												</span>
												<span className="notif-label mono">{f.label.trim()}</span>
												<span className="notif-ago">{fmtAgo(f.ts)}</span>
											</div>
											<div className="notif-summary">{f.summary}</div>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}
