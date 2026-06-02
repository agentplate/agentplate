// Agentplate OS — TenacitOS-style control center.
//
// An OS-shell layout: a left icon-rail, a topbar with command search + user,
// the active screen, and a bottom status bar showing live host metrics. Owns the
// single WebSocket connection (5s cadence) and a polled system-metrics fetch for
// the status bar, and opens the agent detail drawer over any screen.
//
// Liveness: the WS snapshot is the primary feed, but it can drop (e.g. a proxy or
// editor browser that doesn't tunnel WebSockets) while plain HTTP still works. So
// we ALSO poll the REST endpoints and apply them whenever the WS is not connected,
// keeping agents/tasks/feed fresh instead of freezing on the last snapshot.

import { useEffect, useMemo, useRef, useState } from "react";
import { connectWs, getAgents, getFeed, getOverview, getSystem, getTasks } from "./api.ts";
import { fmtUptime } from "./lib.tsx";
import { BrandMark, BrandSpark, IconSearch, NAV_ICON } from "./icons.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { NotificationBell } from "./NotificationBell.tsx";
import { AgentsScreen } from "./screens/Agents.tsx";
import { ChatScreen } from "./screens/Chat.tsx";
import { CostsScreen } from "./screens/Costs.tsx";
import { DeployScreen } from "./screens/Deploy.tsx";
import { FeedScreen } from "./screens/Feed.tsx";
import { HandoffsScreen } from "./screens/Handoffs.tsx";
import { MissionControl } from "./screens/MissionControl.tsx";
import { OfficeScreen } from "./screens/Office.tsx";
import { SessionsScreen } from "./screens/Sessions.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SkillsScreen } from "./screens/Skills.tsx";
import { SystemScreen } from "./screens/System.tsx";
import { TasksScreen } from "./screens/Tasks.tsx";
import { AgentDrawer } from "./screens/AgentDrawer.tsx";
import type {
	AgentSession,
	FeedItem,
	Overview,
	Snapshot,
	StatusCounts,
	SystemMetrics,
	TaskItem,
} from "./types.ts";

type TabId =
	| "dashboard"
	| "system"
	| "agents"
	| "office"
	| "tasks"
	| "handoffs"
	| "activity"
	| "sessions"
	| "skills"
	| "costs"
	| "chat"
	| "deploy"
	| "settings";

const NAV: { id: TabId; label: string }[] = [
	{ id: "dashboard", label: "Dashboard" },
	{ id: "system", label: "System" },
	{ id: "agents", label: "Agents" },
	{ id: "office", label: "Office" },
	{ id: "tasks", label: "Tasks" },
	{ id: "handoffs", label: "Handoffs" },
	{ id: "activity", label: "Activity" },
	{ id: "sessions", label: "Runs" },
	{ id: "skills", label: "Skills" },
	{ id: "costs", label: "Costs" },
	{ id: "chat", label: "Chat" },
	{ id: "deploy", label: "Deploy" },
	{ id: "settings", label: "Settings" },
];

const EMPTY_COUNTS: StatusCounts = { idle: 0, working: 0, completed: 0, stalled: 0 };

/**
 * Derive status counts from the agent list (mirrors the server's buildStatusCounts):
 * booting/working → working, idle → idle, completed → completed, anything else
 * (failed/stopped) → stalled. Used by the REST fallback, where the WS-computed
 * `statusCounts` is unavailable.
 */
function deriveCounts(agents: AgentSession[]): StatusCounts {
	const counts: StatusCounts = { idle: 0, working: 0, completed: 0, stalled: 0 };
	for (const a of agents) {
		if (a.state === "working" || a.state === "booting") counts.working++;
		else if (a.state === "idle") counts.idle++;
		else if (a.state === "completed") counts.completed++;
		else counts.stalled++;
	}
	return counts;
}

export function App(): JSX.Element {
	const [tab, setTab] = useState<TabId>("dashboard");
	const [connected, setConnected] = useState(false);
	const [overview, setOverview] = useState<Overview | null>(null);
	const [agents, setAgents] = useState<AgentSession[]>([]);
	const [counts, setCounts] = useState<StatusCounts>(EMPTY_COUNTS);
	const [tasks, setTasks] = useState<TaskItem[]>([]);
	const [feed, setFeed] = useState<FeedItem[]>([]);
	const [system, setSystem] = useState<SystemMetrics | null>(null);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const [paletteOpen, setPaletteOpen] = useState(false);

	// Global ⌘K / Ctrl+K toggles the command palette.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPaletteOpen((v) => !v);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	useEffect(() => {
		const handle = connectWs({
			onSnapshot: (snap: Snapshot) => {
				setOverview(snap.overview);
				setAgents(Array.isArray(snap.agents) ? snap.agents : []);
				setCounts(snap.statusCounts ?? EMPTY_COUNTS);
				setTasks(Array.isArray(snap.tasks) ? snap.tasks : []);
				setFeed(Array.isArray(snap.feed) ? snap.feed : []);
			},
			onStatus: setConnected,
		});
		return () => handle.close();
	}, []);

	// REST fallback: when the WS is NOT connected, poll the same data over HTTP so
	// agents/tasks/feed keep updating instead of freezing on the last snapshot. A
	// ref (not the state) is read inside the interval so the live WS connection
	// suppresses the poll without re-creating the timer on every status flip.
	const connectedRef = useRef(connected);
	useEffect(() => {
		connectedRef.current = connected;
	}, [connected]);
	useEffect(() => {
		let cancelled = false;
		const tick = async () => {
			if (connectedRef.current) return; // WS is live and already driving updates.
			try {
				const [ag, ov, tk, fd] = await Promise.all([
					getAgents(),
					getOverview().catch(() => null),
					getTasks().catch(() => []),
					getFeed(40).catch(() => []),
				]);
				if (cancelled) return;
				setAgents(ag);
				setCounts(deriveCounts(ag));
				if (ov) setOverview(ov);
				setTasks(tk);
				setFeed(fd);
			} catch {
				// Whole-host unreachable: the status bar already shows OFFLINE; retry next tick.
			}
		};
		tick();
		const t = window.setInterval(tick, 4000);
		return () => {
			cancelled = true;
			window.clearInterval(t);
		};
	}, []);

	// Poll host metrics for the status bar (every 5s).
	useEffect(() => {
		let cancelled = false;
		const load = () =>
			getSystem()
				.then((m) => !cancelled && setSystem(m))
				.catch(() => {});
		load();
		const t = window.setInterval(load, 5000);
		return () => {
			cancelled = true;
			window.clearInterval(t);
		};
	}, []);

	const screen = useMemo(() => {
		switch (tab) {
			case "dashboard":
				return (
					<MissionControl
						overview={overview}
						agents={agents}
						counts={counts}
						onOpenOffice={() => setTab("office")}
						onSelect={setSelectedAgent}
					/>
				);
			case "system":
				return <SystemScreen />;
			case "agents":
				return <AgentsScreen agents={agents} counts={counts} onSelect={setSelectedAgent} />;
			case "office":
				return <OfficeScreen agents={agents} onSelect={setSelectedAgent} />;
			case "tasks":
				return <TasksScreen tasks={tasks} live={connected} />;
			case "handoffs":
				return <HandoffsScreen />;
			case "activity":
				return <FeedScreen feed={feed} live={connected} />;
			case "sessions":
				return <SessionsScreen onSelect={setSelectedAgent} />;
			case "skills":
				return <SkillsScreen />;
			case "costs":
				return <CostsScreen />;
			case "chat":
				return <ChatScreen feed={feed} />;
			case "deploy":
				return <DeployScreen />;
			case "settings":
				return <SettingsScreen overview={overview} />;
			default:
				return null;
		}
	}, [tab, overview, agents, counts, tasks, feed, connected]);

	const userInitial = (overview?.project ?? "A").charAt(0).toUpperCase();
	const agentNames = useMemo(() => new Set(agents.map((a) => a.agentName)), [agents]);

	return (
		<div className="os">
			{/* Icon rail */}
			<nav className="rail">
				<div className="rail-logo" title="Agentplate">
					<BrandSpark size={26} color="#fff" />
				</div>
				{NAV.map((n) => {
					const Icon = NAV_ICON[n.id];
					return (
						<button
							key={n.id}
							type="button"
							className={`rail-item ${tab === n.id ? "active" : ""}`}
							onClick={() => setTab(n.id)}
						>
							<span className="ri-icon">{Icon ? <Icon size={20} strokeWidth={2} /> : null}</span>
							<span className="ri-label">{n.label}</span>
						</button>
					);
				})}
			</nav>

			{/* Topbar */}
			<header className="topbar">
				<div className="topbar-brand">
					<span className="brand-glyph">
						<BrandMark size={20} />
					</span>
					<span>Agentplate</span>
					<span className="ver-pill">OS</span>
				</div>
				<div className="topbar-spacer" />
				<button type="button" className="topbar-search" onClick={() => setPaletteOpen(true)}>
					<IconSearch size={15} strokeWidth={2} />
					<span>Search…</span>
					<kbd>⌘K</kbd>
				</button>
				<NotificationBell feed={feed} agentNames={agentNames} onSelectAgent={setSelectedAgent} />
				<div className="topbar-user">
					<span className="avatar">{userInitial}</span>
				</div>
			</header>

			{/* Active screen */}
			<main className="main">{screen}</main>

			{/* Status bar */}
			<footer className="statusbar">
				<StatusMetric
					label="CPU"
					value={system ? `${system.cpu.percent}%` : "—"}
					pct={system?.cpu.percent ?? 0}
				/>
				<StatusMetric
					label="RAM"
					value={system ? `${system.memory.percent}%` : "—"}
					pct={system?.memory.percent ?? 0}
				/>
				<StatusMetric
					label="DISK"
					value={system?.disk.percent != null ? `${system.disk.percent}%` : "—"}
					pct={system?.disk.percent ?? 0}
				/>
				<div className="sb-spacer" />
				<span className="sb-item">
					<span className="sb-dot" style={{ background: connected ? "var(--ok)" : "var(--err)" }} />
					<span className="sb-key">{connected ? "LIVE" : "OFFLINE"}</span>
				</span>
				{system ? (
					<span className="sb-item">
						<span className="sb-key">UPTIME</span>
						<span className="sb-val">{fmtUptime(system.uptimeSeconds)}</span>
					</span>
				) : null}
				{system ? <span className="sb-item faint">{system.hostname}</span> : null}
			</footer>

			{selectedAgent ? (
				<AgentDrawer name={selectedAgent} onClose={() => setSelectedAgent(null)} />
			) : null}

			<CommandPalette
				open={paletteOpen}
				nav={NAV}
				agents={agents.map((a) => a.agentName)}
				onClose={() => setPaletteOpen(false)}
				onNavigate={(id) => setTab(id as TabId)}
				onSelectAgent={setSelectedAgent}
			/>
		</div>
	);
}

function StatusMetric({
	label,
	value,
	pct,
}: {
	label: string;
	value: string;
	pct: number;
}): JSX.Element {
	const color = pct >= 90 ? "var(--err)" : pct >= 70 ? "var(--warn)" : "var(--ok)";
	return (
		<span className="sb-item">
			<span className="sb-key">{label}</span>
			<span className="sb-val">{value}</span>
			<span className="sb-bar">
				<span style={{ width: `${Math.min(100, pct)}%`, background: color }} />
			</span>
		</span>
	);
}
