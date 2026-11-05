// Agent detail drawer — opens when an agent is clicked in the Fleet board.
//
// Slides in from the right and shows the full per-agent picture, polled every
// 5s while open: identity + session metadata, the mail it has sent and received
// (its handoff conversation), recent events (tool calls / state changes), and
// any child agents it spawned. Closes on Escape, backdrop click or the × button.
//
// Modal semantics: focus moves to the × button on open, Tab/Shift+Tab cycle
// inside the panel, and focus returns to whatever opened the drawer on close.
//
// The new theme.css has no .drawer-* / .kv-* classes, so the drawer chrome is
// inline-styled; content uses the shared <Card> + Badge / stateTone helpers.

import { useEffect, useRef } from "react";
import { getAgentDetail } from "../api.ts";
import { agentColor, Badge, Card, clock, fmtAgo, stateTone } from "../lib.tsx";
import type { AgentDetail, MailMessage } from "../types.ts";
import { usePolling } from "../usePolling.ts";

function StateBadge({ state }: { state: string }): JSX.Element {
	const { tone, label } = stateTone(state);
	return <Badge tone={tone}>{label}</Badge>;
}

function Field({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
	return (
		<>
			<span className="faint" style={{ fontSize: 12, padding: "5px 0" }}>
				{label}
			</span>
			<span style={{ padding: "5px 0", minWidth: 0, wordBreak: "break-word" }}>{value}</span>
		</>
	);
}

function MailLine({ m, dir }: { m: MailMessage; dir: "in" | "out" }): JSX.Element {
	return (
		<li
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				flexWrap: "wrap",
				paddingBottom: 8,
				borderBottom: "1px solid var(--border-soft)",
			}}
		>
			<Badge tone={dir === "in" ? "info" : "accent"}>{dir === "in" ? "◀ in" : "out ▶"}</Badge>
			<span className="mono dim">{dir === "in" ? m.from : m.to}</span>
			<span className="faint" style={{ fontSize: 12 }}>
				{m.type}
			</span>
			<span style={{ flex: 1, minWidth: 120 }}>{m.subject}</span>
			<span className="dim" style={{ fontSize: 12 }}>
				{fmtAgo(m.createdAt)}
			</span>
		</li>
	);
}

const kvGrid: React.CSSProperties = {
	display: "grid",
	gridTemplateColumns: "minmax(110px, max-content) 1fr",
	columnGap: 16,
	alignItems: "baseline",
	fontSize: 13,
};

const listReset: React.CSSProperties = {
	listStyle: "none",
	margin: 0,
	padding: 0,
	display: "flex",
	flexDirection: "column",
	gap: 10,
};

export function AgentDrawer({ name, onClose }: { name: string; onClose: () => void }): JSX.Element {
	const { data, error } = usePolling<AgentDetail>(() => getAgentDetail(name), 5000);
	const s = data?.session ?? null;
	const panelRef = useRef<HTMLElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	// Focus in on open, restore on close.
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		closeRef.current?.focus();
		return () => previous?.focus();
	}, []);

	// Escape closes; Tab is trapped inside the panel. Window-level so it works
	// wherever focus is, but yields to an overlay above (the ⌘K palette handles
	// its own Escape and calls preventDefault).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return;
			if (e.key === "Escape") {
				e.preventDefault();
				onCloseRef.current();
				return;
			}
			if (e.key !== "Tab") return;
			const panel = panelRef.current;
			if (!panel) return;
			const active = document.activeElement;
			// The ⌘K palette sits above the drawer and owns focus while open.
			if (active?.closest(".cmdk")) return;
			const inPanel = active !== null && panel.contains(active);
			const focusable = Array.from(
				panel.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
				),
			).filter((el) => !el.hasAttribute("disabled"));
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (!first || !last) return;
			if (!inPanel) {
				e.preventDefault();
				first.focus();
			} else if (e.shiftKey && active === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && active === last) {
				e.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Merge inbox + sent into one time-ordered conversation for the handoff view.
	const conversation = [
		...(data?.inbox ?? []).map((m) => ({ m, dir: "in" as const })),
		...(data?.sent ?? []).map((m) => ({ m, dir: "out" as const })),
	].sort((a, b) => (a.m.createdAt < b.m.createdAt ? 1 : -1));

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse-only convenience; keyboard users close with Escape or the focused × button.
		<div
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			role="presentation"
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0,0,0,0.5)",
				display: "flex",
				justifyContent: "flex-end",
				zIndex: 50,
			}}
		>
			<aside
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-label={`Agent ${name}`}
				style={{
					width: "min(560px, 100%)",
					height: "100%",
					background: "var(--bg-card)",
					borderLeft: "1px solid var(--border)",
					overflowY: "auto",
					padding: 18,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "flex-start",
						justifyContent: "space-between",
						gap: 12,
						marginBottom: 18,
					}}
				>
					<div>
						<div
							style={{
								fontSize: 24,
								fontWeight: 800,
								letterSpacing: "-0.02em",
								color: agentColor(name),
							}}
						>
							{name}
						</div>
						<div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
							{s ? s.capability : "agent"} · refreshes every 5s
						</div>
					</div>
					<button
						ref={closeRef}
						type="button"
						className="btn"
						onClick={onClose}
						aria-label="Close agent details"
					>
						×
					</button>
				</div>

				{error ? (
					<div
						style={{
							background: "var(--err-soft)",
							border: "1px solid var(--accent-border)",
							color: "var(--err)",
							borderRadius: "9px",
							padding: "10px 14px",
							marginBottom: 16,
							fontSize: 13,
							fontWeight: 600,
						}}
					>
						{error}
					</div>
				) : null}

				{!s ? (
					<div className="empty">No live session for this agent.</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
						<Card title="Session">
							<div style={kvGrid}>
								<Field label="State" value={<StateBadge state={s.state} />} />
								<Field label="Capability" value={s.capability} />
								<Field label="Task" value={<span className="mono">{s.taskId || "—"}</span>} />
								<Field label="Run" value={<span className="mono">{s.runId}</span>} />
								<Field label="Parent" value={s.parentAgent ?? "—"} />
								<Field label="Depth" value={String(s.depth)} />
								<Field label="Branch" value={<span className="mono">{s.branchName || "—"}</span>} />
								<Field label="PID" value={s.pid != null ? String(s.pid) : "—"} />
								<Field label="Worktree" value={<span className="mono">{s.worktreePath}</span>} />
								<Field label="Started" value={clock(s.startedAt)} />
								<Field
									label="Last activity"
									value={`${fmtAgo(s.lastActivity)} (${clock(s.lastActivity)})`}
								/>
								<Field
									label="Runtime session"
									value={<span className="mono">{s.runtimeSessionId ?? "—"}</span>}
								/>
							</div>
						</Card>

						<Card title="Handoff communications" meta={`${conversation.length} messages`}>
							{conversation.length === 0 ? (
								<div className="empty">No mail to or from this agent yet.</div>
							) : (
								<ul style={listReset}>
									{conversation.map(({ m, dir }) => (
										<MailLine key={`${m.id}-${dir}`} m={m} dir={dir} />
									))}
								</ul>
							)}
						</Card>

						{data?.children && data.children.length > 0 ? (
							<Card title="Spawned agents" meta={`${data.children.length}`}>
								<ul style={listReset}>
									{data.children.map((c) => (
										<li
											key={c.id}
											style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
										>
											<StateBadge state={c.state} />
											<span className="mono" style={{ color: agentColor(c.agentName) }}>
												{c.agentName}
											</span>
											<span className="dim">
												{c.capability} · {c.taskId}
											</span>
										</li>
									))}
								</ul>
							</Card>
						) : null}

						<Card title="Recent activity" meta={`${data?.events.length ?? 0} events`}>
							{!data || data.events.length === 0 ? (
								<div className="empty">No events recorded yet.</div>
							) : (
								<ul style={listReset}>
									{data.events.map((e) => (
										<li
											key={e.id}
											style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}
										>
											<span className="dim" style={{ fontSize: 12 }}>
												{fmtAgo(e.createdAt)}
											</span>
											<span className="mono" style={{ fontSize: 12.5 }}>
												{e.tool ? `${e.type}: ${e.tool}` : e.type}
											</span>
											{e.detail ? <span className="dim">— {e.detail}</span> : null}
										</li>
									))}
								</ul>
							)}
						</Card>
					</div>
				)}
			</aside>
		</div>
	);
}
