// Command palette (⌘K / Ctrl+K).
//
// A real, keyboard-driven launcher that replaces the old decorative search box.
// It searches two things: the screens (jump to any nav tab) and the live agents
// (open an agent's detail drawer). Arrow keys move the selection, Enter runs it,
// Esc closes. Opened by clicking the topbar search or pressing ⌘K / Ctrl+K.

import { useEffect, useMemo, useRef, useState } from "react";
import { IconAgents, type LucideIcon, NAV_ICON } from "./icons.tsx";
import { agentColor } from "./lib.tsx";

export interface NavEntry {
	id: string;
	label: string;
}

interface Result {
	kind: "screen" | "agent";
	id: string; // tab id or agent name
	label: string;
	icon: LucideIcon;
	color?: string; // agent signature color
}

export function CommandPalette({
	open,
	nav,
	agents,
	onClose,
	onNavigate,
	onSelectAgent,
}: {
	open: boolean;
	nav: NavEntry[];
	agents: string[];
	onClose: () => void;
	onNavigate: (id: string) => void;
	onSelectAgent: (name: string) => void;
}): JSX.Element | null {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	// Reset + focus whenever it opens.
	useEffect(() => {
		if (open) {
			setQuery("");
			setActive(0);
			// Focus after paint so the input exists.
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open]);

	const results = useMemo<Result[]>(() => {
		const q = query.trim().toLowerCase();
		const screens: Result[] = nav
			.filter((n) => !q || n.label.toLowerCase().includes(q) || n.id.includes(q))
			.map((n) => ({ kind: "screen", id: n.id, label: n.label, icon: NAV_ICON[n.id] ?? IconAgents }));
		const ags: Result[] = agents
			.filter((name) => !q || name.toLowerCase().includes(q))
			.map((name) => ({
				kind: "agent",
				id: name,
				label: name,
				icon: IconAgents,
				color: agentColor(name),
			}));
		return [...screens, ...ags];
	}, [query, nav, agents]);

	// Keep the active index in range as results shrink.
	useEffect(() => {
		if (active >= results.length) setActive(results.length > 0 ? results.length - 1 : 0);
	}, [results.length, active]);

	if (!open) return null;

	function run(r: Result | undefined): void {
		if (!r) return;
		if (r.kind === "screen") onNavigate(r.id);
		else onSelectAgent(r.id);
		onClose();
	}

	function onKeyDown(e: React.KeyboardEvent): void {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((i) => Math.min(i + 1, results.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			run(results[active]);
		}
	}

	const firstAgent = results.findIndex((r) => r.kind === "agent");

	return (
		<div className="cmdk-backdrop" onMouseDown={onClose} role="presentation">
			<div
				className="cmdk"
				onMouseDown={(e) => e.stopPropagation()}
				role="dialog"
				aria-label="Command palette"
			>
				<input
					ref={inputRef}
					className="cmdk-input"
					placeholder="Jump to a screen or an agent…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={onKeyDown}
				/>
				<div className="cmdk-list">
					{results.length === 0 ? (
						<div className="cmdk-empty">No matches</div>
					) : (
						results.map((r, i) => {
							const Icon = r.icon;
							const showScreensHeader = i === 0 && r.kind === "screen";
							const showAgentsHeader = i === firstAgent && firstAgent > 0;
							return (
								<div key={`${r.kind}:${r.id}`}>
									{showScreensHeader ? <div className="cmdk-section">Screens</div> : null}
									{showAgentsHeader ? <div className="cmdk-section">Agents</div> : null}
									<button
										type="button"
										className={`cmdk-item ${i === active ? "active" : ""}`}
										onMouseEnter={() => setActive(i)}
										onClick={() => run(r)}
									>
										<span
											className="cmdk-icon"
											style={r.color ? { color: r.color } : undefined}
										>
											<Icon size={16} strokeWidth={2} />
										</span>
										<span className="cmdk-label">{r.label}</span>
										<span className="cmdk-kind">{r.kind === "agent" ? "open" : "go"}</span>
									</button>
								</div>
							);
						})
					)}
				</div>
				<div className="cmdk-foot">
					<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
					<span><kbd>↵</kbd> select</span>
					<span><kbd>esc</kbd> close</span>
				</div>
			</div>
		</div>
	);
}
