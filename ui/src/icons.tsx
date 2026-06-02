// Central flat-icon module (lucide-react).
//
// One import surface for every icon used across the UI, aliased to semantic
// names so screens don't couple to lucide's naming. Also exports the rail/page
// nav-icon map and <PageIcon>, the gradient icon chip shown next to page titles.

import {
	Activity,
	AlertTriangle,
	ArrowLeftRight,
	ArrowRight,
	Bell,
	Bot,
	Building2,
	Check,
	CheckCircle2,
	Clock,
	CornerDownRight,
	DollarSign,
	Footprints,
	Gamepad2,
	Gauge,
	History,
	Keyboard,
	Layers,
	LayoutDashboard,
	type LucideIcon,
	MessagesSquare,
	Moon,
	Mouse,
	MousePointerClick,
	Network,
	Orbit,
	Puzzle,
	Rocket,
	Search,
	Settings,
	Target,
	ListTodo,
	Users,
	Wallet,
	Zap,
	ZoomIn,
} from "lucide-react";

export type { LucideIcon };

// --- Semantic aliases -------------------------------------------------------

export const IconDashboard = LayoutDashboard;
export const IconSystem = Gauge;
export const IconAgents = Bot;
export const IconOffice = Building2;
export const IconTasks = ListTodo;
export const IconHandoffs = ArrowLeftRight;
export const IconActivity = Activity;
export const IconRuns = History;
export const IconSkills = Puzzle;
export const IconCosts = Wallet;
export const IconChat = MessagesSquare;
export const IconDeploy = Rocket;
export const IconSettings = Settings;

export const IconSearch = Search;
export const IconBell = Bell;
export const IconNetwork = Network;
export const IconGame = Gamepad2;

export const IconActive = Zap;
export const IconCompleted = CheckCircle2;
export const IconError = AlertTriangle;
export const IconIdle = Moon;
export const IconUsers = Users;
export const IconLayers = Layers;
export const IconTarget = Target;
export const IconCheck = Check;
export const IconCost = DollarSign;
export const IconClock = Clock;
export const IconArrowRight = ArrowRight;
export const IconChild = CornerDownRight;

// Office overlay controls
export const IconOrbit = Orbit;
export const IconFps = Footprints;
export const IconKeyboard = Keyboard;
export const IconMouse = Mouse;
export const IconClick = MousePointerClick;
export const IconZoom = ZoomIn;

// --- Nav-icon map (rail + screen titles) ------------------------------------

export const NAV_ICON: Record<string, LucideIcon> = {
	dashboard: IconDashboard,
	system: IconSystem,
	agents: IconAgents,
	office: IconOffice,
	tasks: IconTasks,
	handoffs: IconHandoffs,
	activity: IconActivity,
	sessions: IconRuns,
	skills: IconSkills,
	costs: IconCosts,
	chat: IconChat,
	deploy: IconDeploy,
	settings: IconSettings,
};

// --- Title chip -------------------------------------------------------------

export type ChipTone = "accent" | "ok" | "warn" | "info" | "violet" | "cyan";

/** Gradient rounded chip + flat icon, shown beside a page title. */
export function PageIcon({
	icon: Icon,
	tone = "accent",
}: {
	icon: LucideIcon;
	tone?: ChipTone;
}): JSX.Element {
	return (
		<span className={`title-icon ${tone}`}>
			<Icon size={22} strokeWidth={2.2} />
		</span>
	);
}

// --- Brand mark — "Plate & Spark" -------------------------------------------
//
// A plate ring cradling a radial spark: a central coordinator with agent spokes
// fanning out. <BrandSpark> is the spark alone (for use on a filled tile, e.g.
// the rail logo); <BrandMark> is the full ring + spark (e.g. the topbar brand).
// Both inherit `currentColor` unless a color is passed.

const SPARK_RAY = "M -3.2,-14 L -1.8,-40 Q0,-44 1.8,-40 L 3.2,-14 Q0,-11 -3.2,-14 Z";
const RAY_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

/** The radial spark alone (rays + hub), single color. */
export function BrandSpark({
	size = 24,
	color = "currentColor",
}: {
	size?: number;
	color?: string;
}): JSX.Element {
	return (
		<svg width={size} height={size} viewBox="0 0 120 120" fill={color} aria-hidden="true">
			<g transform="translate(60,60)">
				{RAY_ANGLES.map((a) => (
					<path key={a} d={SPARK_RAY} transform={`rotate(${a})`} />
				))}
				<circle cx="0" cy="0" r="8.5" />
			</g>
		</svg>
	);
}

/** The full Plate & Spark mark: plate ring + spark, single color. */
export function BrandMark({
	size = 24,
	color = "currentColor",
}: {
	size?: number;
	color?: string;
}): JSX.Element {
	return (
		<svg width={size} height={size} viewBox="0 0 120 120" fill="none" aria-hidden="true">
			<circle cx="60" cy="60" r="46" stroke={color} strokeWidth="7" />
			<g transform="translate(60,60)" fill={color}>
				{RAY_ANGLES.map((a) => (
					<path key={a} d={SPARK_RAY} transform={`rotate(${a})`} />
				))}
				<circle cx="0" cy="0" r="8.5" />
			</g>
		</svg>
	);
}
