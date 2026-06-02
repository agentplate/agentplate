// Office 3D — a furnished voxel office where agents *act out* what they're doing.
//
// A wooden-plank floor inside a navy-walled room with brown desks. Each agent is
// a jointed humanoid (hip/knee/shoulder/elbow/head) wearing a role-specific kit
// (hat + held prop + team color), playing a behavior driven by live data:
//   • idle     → stands at its desk, sways, glances around
//   • working  → sits in the chair and types (booting/working)
//   • meeting  → when it's part of a recent handoff (/api/handoffs), it walks to
//                the whiteboard and discusses — the sender gestures and shows a
//                speech bubble; the receiver listens.
//   • leaving  → a completed agent lingers briefly (dimmed) then leaves the room.
// The coordinator presides from a corner office at the head of the room, facing
// the team. Monitors glow with the agent's state color. Click an avatar for its
// drawer. Operator can Orbit (drag + scroll) or switch to an FPS walk-around.

import { Html, OrbitControls, PointerLockControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Group } from "three";
import { getHandoffs } from "../api.ts";
import {
	IconClick,
	IconFps,
	IconKeyboard,
	IconMouse,
	IconOffice,
	IconOrbit,
	IconZoom,
	type LucideIcon,
	PageIcon,
} from "../icons.tsx";
import { agentColor } from "../lib.tsx";
import type { AgentSession, Handoff } from "../types.ts";
import { usePolling } from "../usePolling.ts";

type Vec3 = [number, number, number];

const damp = THREE.MathUtils.damp;

/** Angle damping that takes the shortest path around the circle. */
function dampAngle(cur: number, goal: number, lambda: number, dt: number): number {
	const d = Math.atan2(Math.sin(goal - cur), Math.cos(goal - cur));
	return cur + d * (1 - Math.exp(-lambda * dt));
}

// --- State → reference legend (Working / Thinking / Idle / Done / Error) -----

interface StateStyle {
	color: string;
	label: string;
}

const STATE_3D: Record<string, StateStyle> = {
	working: { color: "#41d15f", label: "Working" },
	booting: { color: "#3b82f6", label: "Thinking" },
	idle: { color: "#9aa0a8", label: "Idle" },
	completed: { color: "#5eead4", label: "Done" },
	stopped: { color: "#9aa0a8", label: "Idle" },
	failed: { color: "#f5402d", label: "Error" },
};

function state3d(state: string): StateStyle {
	return STATE_3D[state] ?? { color: "#9aa0a8", label: "Idle" };
}

const LEGEND: StateStyle[] = [
	{ color: "#41d15f", label: "Working" },
	{ color: "#3b82f6", label: "Thinking" },
	{ color: "#9aa0a8", label: "Idle" },
	{ color: "#5eead4", label: "Done" },
	{ color: "#f5402d", label: "Error" },
];

// drei <Html> labels render into the DOM over the canvas. Clamp their z-index to
// this range so the absolutely-positioned overlay panels (set above PANEL_Z) are
// never covered by a floating 3D label.
const LABEL_Z_RANGE: [number, number] = [20, 0];
const PANEL_Z = 30;

// Palette for the room itself.
const WOOD_TABLE = "#a9612f";
const WOOD_TABLE_DARK = "#7c4420";
const PLANK_A = "#b9763c";
const PLANK_B = "#a9692f";
const WALL = "#1b2030";
const SKY = "#bcd2e6";
const SKIN = "#e8b690";
const PANTS = "#2c3550";
const CHAIR = "#27314d";
const RUG = "#7a3b3b";

// --- Role kits (per-capability character) ------------------------------------

type HatKind =
	| "hardhat"
	| "cap"
	| "explorer"
	| "glasses"
	| "headset"
	| "beanie"
	| "headlamp"
	| "none";
type PropKind =
	| "pickaxe"
	| "map"
	| "magnifier"
	| "wrench"
	| "blueprint"
	| "rocket"
	| "clipboard"
	| "ruler"
	| "checkmark"
	| "none";

interface RoleKit {
	color: string;
	hat: HatKind;
	prop: PropKind;
	label: string;
}

// Each capability gets a recognizable voxel kit: a team color (shirt), headgear,
// and a held prop. Keep colors distinct from the STATE legend hues.
const ROLE_KITS: Record<string, RoleKit> = {
	coordinator: { color: "#f5b301", hat: "headset", prop: "clipboard", label: "Coordinator" },
	lead: { color: "#4f86f7", hat: "hardhat", prop: "clipboard", label: "Lead" },
	builder: { color: "#f59e0b", hat: "hardhat", prop: "pickaxe", label: "Builder" },
	scout: { color: "#34d399", hat: "explorer", prop: "map", label: "Scout" },
	reviewer: { color: "#a78bfa", hat: "glasses", prop: "magnifier", label: "Reviewer" },
	merger: { color: "#22d3ee", hat: "cap", prop: "wrench", label: "Merger" },
	architect: { color: "#f778ba", hat: "none", prop: "blueprint", label: "Architect" },
	devops: { color: "#fb7185", hat: "beanie", prop: "wrench", label: "DevOps" },
	deployer: { color: "#ff8a3d", hat: "cap", prop: "rocket", label: "Deployer" },
	verifier: { color: "#60a5fa", hat: "headlamp", prop: "checkmark", label: "Verifier" },
};

function roleKit(capability: string): RoleKit {
	return ROLE_KITS[capability] ?? { color: "#9aa0a8", hat: "none", prop: "none", label: capability };
}

// --- Behavior model ---------------------------------------------------------

type Behavior = "working" | "idle" | "meeting" | "away";

interface MeetingInfo {
	pos: Vec3; // world slot in front of the whiteboard
	faceX: number; // point to face (the board)
	faceZ: number;
	speech: string | null; // what the sender is "saying"
	speaker: boolean; // sender gestures; receiver listens
}

/** A fixed station that overrides the default desk sit/stand placement (used for
 *  the coordinator, who presides standing at the head of the room). */
interface Station {
	pos: Vec3;
	faceX: number;
	faceZ: number;
	sit: boolean;
}

/** Derive the behavior an agent should act out from its lifecycle state. */
function baseBehavior(state: string): Behavior {
	if (state === "working" || state === "booting") return "working";
	if (state === "idle") return "idle";
	return "away"; // completed (lingering) / failed → present but at rest, dimmed
}

/** How long a completed agent lingers ("wrapping up") before it leaves. */
const GRACE_MS = 60_000;

/**
 * Whether an agent is still "in the building" and should get a desk + actor.
 * Live agents (booting/working/idle) and failures always show. A completed agent
 * lingers for {@link GRACE_MS} so finished workers are actually seen before they
 * leave; a reaped/stalled (`stopped`) agent leaves immediately so the office
 * self-clears. (`purgeOnReap` deletes stopped rows from the snapshot entirely.)
 */
function visibleInOffice(a: AgentSession, now: number): boolean {
	switch (a.state) {
		case "working":
		case "booting":
		case "idle":
		case "failed":
			return true;
		case "completed":
			return now - Date.parse(a.lastActivity) < GRACE_MS;
		case "stopped":
			return false;
		default:
			return true;
	}
}

/** A handoff type → a short spoken verb for the speech bubble. */
function handoffVerb(type: string): string {
	switch (type) {
		case "dispatch":
		case "assign":
			return "Assigning";
		case "worker_done":
			return "Handing off";
		case "merge_ready":
			return "Ready to merge";
		case "merged":
			return "Merged";
		case "escalation":
			return "Escalating";
		case "merge_failed":
			return "Merge conflict";
		case "deploy_gate":
			return "Deploy gate";
		default:
			return type.replace(/_/g, " ");
	}
}

// --- Role headgear + props (parented to the rig) -----------------------------

/** Headgear, rendered inside the head group so it pitches/yaws with the head. */
function Hat({
	kind,
	color,
	dim,
	op,
}: {
	kind: HatKind;
	color: string;
	dim: boolean;
	op: number;
}): JSX.Element | null {
	const dark = "#2a2e36";
	const mat = (c: string) => <meshStandardMaterial color={c} transparent={dim} opacity={op} />;
	switch (kind) {
		case "hardhat":
			return (
				<group>
					<mesh position={[0, 0.3, 0]} castShadow>
						<boxGeometry args={[0.5, 0.2, 0.5]} />
						{mat(color)}
					</mesh>
					<mesh position={[0, 0.22, 0.04]}>
						<boxGeometry args={[0.58, 0.05, 0.62]} />
						{mat(color)}
					</mesh>
				</group>
			);
		case "cap":
			return (
				<group>
					<mesh position={[0, 0.3, 0]} castShadow>
						<boxGeometry args={[0.48, 0.18, 0.48]} />
						{mat(color)}
					</mesh>
					<mesh position={[0, 0.25, 0.28]}>
						<boxGeometry args={[0.34, 0.05, 0.24]} />
						{mat(color)}
					</mesh>
				</group>
			);
		case "explorer":
			return (
				<group>
					<mesh position={[0, 0.24, 0]} rotation={[Math.PI / 2, 0, 0]}>
						<cylinderGeometry args={[0.46, 0.46, 0.04, 20]} />
						{mat("#7c5a36")}
					</mesh>
					<mesh position={[0, 0.34, 0]} castShadow>
						<boxGeometry args={[0.38, 0.22, 0.38]} />
						{mat("#8a6a40")}
					</mesh>
				</group>
			);
		case "glasses":
			return (
				<group position={[0, 0.04, 0.235]}>
					<mesh>
						<boxGeometry args={[0.46, 0.04, 0.03]} />
						{mat(dark)}
					</mesh>
					<mesh position={[-0.11, 0, 0.01]}>
						<boxGeometry args={[0.15, 0.13, 0.02]} />
						<meshStandardMaterial color="#bfeaff" transparent opacity={0.55 * op} />
					</mesh>
					<mesh position={[0.11, 0, 0.01]}>
						<boxGeometry args={[0.15, 0.13, 0.02]} />
						<meshStandardMaterial color="#bfeaff" transparent opacity={0.55 * op} />
					</mesh>
				</group>
			);
		case "headset":
			return (
				<group>
					<mesh position={[0, 0.3, 0]}>
						<boxGeometry args={[0.52, 0.08, 0.14]} />
						{mat(dark)}
					</mesh>
					<mesh position={[-0.27, 0.12, 0]}>
						<boxGeometry args={[0.08, 0.18, 0.18]} />
						{mat(color)}
					</mesh>
					<mesh position={[0.27, 0.12, 0]}>
						<boxGeometry args={[0.08, 0.18, 0.18]} />
						{mat(color)}
					</mesh>
					<mesh position={[0.2, 0.0, 0.2]} rotation={[0, 0, 0.5]}>
						<boxGeometry args={[0.04, 0.04, 0.22]} />
						{mat(dark)}
					</mesh>
				</group>
			);
		case "beanie":
			return (
				<group>
					<mesh position={[0, 0.29, 0]} castShadow>
						<boxGeometry args={[0.5, 0.26, 0.5]} />
						{mat(color)}
					</mesh>
					<mesh position={[0, 0.18, 0]}>
						<boxGeometry args={[0.54, 0.09, 0.54]} />
						{mat("#e8e6df")}
					</mesh>
				</group>
			);
		case "headlamp":
			return (
				<group>
					<mesh position={[0, 0.3, 0]} castShadow>
						<boxGeometry args={[0.48, 0.16, 0.48]} />
						{mat(color)}
					</mesh>
					<mesh position={[0, 0.18, 0.26]}>
						<boxGeometry args={[0.12, 0.1, 0.06]} />
						<meshStandardMaterial
							color="#fff7d6"
							emissive="#fff7d6"
							emissiveIntensity={dim ? 0.2 : 0.9}
							transparent={dim}
							opacity={op}
						/>
					</mesh>
				</group>
			);
		default:
			return null;
	}
}

/** A held prop, parented inside the right forearm group (rides with the hand). */
function Prop({
	kind,
	dim,
	op,
}: {
	kind: PropKind;
	dim: boolean;
	op: number;
}): JSX.Element | null {
	const mat = (c: string) => <meshStandardMaterial color={c} transparent={dim} opacity={op} />;
	// Anchor near the hand at the bottom of the forearm, slightly forward.
	return (
		<group position={[0, -0.36, 0.08]}>
			{(() => {
				switch (kind) {
					case "pickaxe":
						return (
							<group>
								<mesh position={[0, -0.08, 0]}>
									<boxGeometry args={[0.04, 0.5, 0.04]} />
									{mat("#7c4a24")}
								</mesh>
								<mesh position={[0, 0.16, 0]} rotation={[0, 0, Math.PI / 2]}>
									<boxGeometry args={[0.05, 0.34, 0.06]} />
									{mat("#9aa0a8")}
								</mesh>
							</group>
						);
					case "map":
						return (
							<mesh rotation={[0.4, 0, 0]}>
								<boxGeometry args={[0.28, 0.32, 0.02]} />
								{mat("#e8dcc0")}
							</mesh>
						);
					case "magnifier":
						return (
							<group>
								<mesh position={[0, -0.12, 0]}>
									<boxGeometry args={[0.04, 0.22, 0.04]} />
									{mat("#3a2e22")}
								</mesh>
								<mesh position={[0, 0.04, 0]} rotation={[Math.PI / 2, 0, 0]}>
									<torusGeometry args={[0.1, 0.025, 8, 18]} />
									{mat("#cbd5e1")}
								</mesh>
							</group>
						);
					case "wrench":
						return (
							<group rotation={[0, 0, 0.3]}>
								<mesh>
									<boxGeometry args={[0.06, 0.34, 0.05]} />
									{mat("#cbd5e1")}
								</mesh>
								<mesh position={[0, 0.2, 0]}>
									<boxGeometry args={[0.16, 0.1, 0.06]} />
									{mat("#aab2bd")}
								</mesh>
							</group>
						);
					case "blueprint":
						return (
							<mesh rotation={[0, 0, Math.PI / 2]}>
								<cylinderGeometry args={[0.05, 0.05, 0.34, 12]} />
								{mat("#2f6fb0")}
							</mesh>
						);
					case "rocket":
						return (
							<group rotation={[0.2, 0, 0]}>
								<mesh position={[0, 0.02, 0]}>
									<cylinderGeometry args={[0.08, 0.08, 0.26, 14]} />
									{mat("#eef2f7")}
								</mesh>
								<mesh position={[0, 0.2, 0]}>
									<coneGeometry args={[0.08, 0.12, 14]} />
									{mat("#f5402d")}
								</mesh>
								<mesh position={[0, -0.14, 0]}>
									<boxGeometry args={[0.06, 0.08, 0.06]} />
									<meshStandardMaterial
										color="#ff8a3d"
										emissive="#ff8a3d"
										emissiveIntensity={dim ? 0.2 : 0.9}
										transparent={dim}
										opacity={op}
									/>
								</mesh>
							</group>
						);
					case "clipboard":
						return (
							<group rotation={[0.5, 0, 0]}>
								<mesh>
									<boxGeometry args={[0.24, 0.32, 0.02]} />
									{mat("#3a4250")}
								</mesh>
								<mesh position={[0, -0.01, 0.015]}>
									<boxGeometry args={[0.2, 0.26, 0.01]} />
									{mat("#f4f4f0")}
								</mesh>
								<mesh position={[0, 0.16, 0.02]}>
									<boxGeometry args={[0.1, 0.04, 0.02]} />
									{mat("#aab2bd")}
								</mesh>
							</group>
						);
					case "ruler":
						return (
							<mesh>
								<boxGeometry args={[0.04, 0.42, 0.02]} />
								{mat("#fbbf24")}
							</mesh>
						);
					case "checkmark":
						return (
							<group>
								<mesh position={[-0.04, -0.04, 0]} rotation={[0, 0, Math.PI / 4]}>
									<boxGeometry args={[0.05, 0.16, 0.04]} />
									<meshStandardMaterial
										color="#41d15f"
										emissive="#41d15f"
										emissiveIntensity={dim ? 0.1 : 0.6}
										transparent={dim}
										opacity={op}
									/>
								</mesh>
								<mesh position={[0.08, 0.04, 0]} rotation={[0, 0, -Math.PI / 4]}>
									<boxGeometry args={[0.05, 0.3, 0.04]} />
									<meshStandardMaterial
										color="#41d15f"
										emissive="#41d15f"
										emissiveIntensity={dim ? 0.1 : 0.6}
										transparent={dim}
										opacity={op}
									/>
								</mesh>
							</group>
						);
					default:
						return null;
				}
			})()}
		</group>
	);
}

// Rig dimensions (feet at y=0 when standing).
const HIP_STAND = 0.78;
const HIP_SIT = 0.56;
const THIGH = 0.4;
const SHIN = 0.36;

/**
 * A jointed humanoid that walks to its target and plays a pose. All animation
 * is driven in useFrame from a ref (so it never reads stale props), damping
 * joint rotations toward per-behavior goals: stand, sit+type, walk, or talk.
 * Appearance comes from the agent's role kit (shirt color + hat + held prop),
 * with the per-agent name color kept as a nameplate/stripe accent.
 */
function Actor({
	agent,
	deskPos,
	behavior,
	meeting,
	station,
	onSelect,
}: {
	agent: AgentSession;
	deskPos: Vec3;
	behavior: Behavior;
	meeting: MeetingInfo | null;
	station?: Station | null;
	onSelect: (name: string) => void;
}): JSX.Element {
	const kit = roleKit(agent.capability);
	const shirt = kit.color;
	const accent = agentColor(agent.agentName);
	const dim = behavior === "away";
	const isCoordinator = agent.capability === "coordinator";
	const [hovered, setHovered] = useState(false);

	const root = useRef<Group>(null);
	const pelvis = useRef<Group>(null);
	const lThigh = useRef<Group>(null);
	const rThigh = useRef<Group>(null);
	const lShin = useRef<Group>(null);
	const rShin = useRef<Group>(null);
	const lSh = useRef<Group>(null);
	const rSh = useRef<Group>(null);
	const lEl = useRef<Group>(null);
	const rEl = useRef<Group>(null);
	const head = useRef<Group>(null);

	// Resolve the world target + facing + pose from the current behavior.
	const [dx, , dz] = deskPos;
	const sitPos: Vec3 = [dx, 0, dz + 0.62];
	const standPos: Vec3 = [dx + 0.85, 0, dz + 1.05];
	const sit = behavior === "meeting" ? false : station ? station.sit : behavior === "working";
	const goal =
		behavior === "meeting" && meeting
			? { tx: meeting.pos[0], tz: meeting.pos[2], faceX: meeting.faceX, faceZ: meeting.faceZ }
			: station
				? { tx: station.pos[0], tz: station.pos[2], faceX: station.faceX, faceZ: station.faceZ }
				: behavior === "working"
					? { tx: sitPos[0], tz: sitPos[2], faceX: dx, faceZ: dz - 1 } // face the monitor
					: { tx: standPos[0], tz: standPos[2], faceX: dx, faceZ: dz }; // face the desk
	const homePos: Vec3 = station ? station.pos : standPos;

	const stateRef = useRef({
		...goal,
		behavior,
		sit,
		speaker: meeting?.speaker ?? false,
	});
	stateRef.current = {
		...goal,
		behavior,
		sit,
		speaker: meeting?.speaker ?? false,
	};

	// Place the actor at its home spot on first mount so it doesn't slide in from 0,0.
	const inited = useRef(false);
	useEffect(() => {
		if (root.current && !inited.current) {
			root.current.position.set(homePos[0], 0, homePos[2]);
			inited.current = true;
		}
	}, [homePos]);

	useFrame((s, delta) => {
		const r = root.current;
		const p = pelvis.current;
		if (!r || !p) return;
		const dt = Math.min(delta, 0.05);
		const t = stateRef.current;
		const time = s.clock.elapsedTime + agent.agentName.length;

		// Walk toward the target (x/z); detect movement.
		const cx = r.position.x;
		const cz = r.position.z;
		const dist = Math.hypot(t.tx - cx, t.tz - cz);
		const moving = dist > 0.12;
		r.position.x = damp(cx, t.tx, 2.4, dt);
		r.position.z = damp(cz, t.tz, 2.4, dt);

		// Facing: toward the destination while walking, else toward the focus.
		const yawGoal = moving
			? Math.atan2(t.tx - cx, t.tz - cz)
			: Math.atan2(t.faceX - cx, t.faceZ - cz);
		r.rotation.y = dampAngle(r.rotation.y, yawGoal, 8, dt);

		const sitNow = t.sit && !moving;
		p.position.y = damp(p.position.y, sitNow ? HIP_SIT : HIP_STAND, 7, dt);

		// Pose goals.
		let lThG = 0;
		let rThG = 0;
		let lShinG = 0;
		let rShinG = 0;
		let lShG = 0.06;
		let rShG = 0.06;
		let lElG = -0.05;
		let rElG = -0.05;
		let headPitch = 0;
		let headYaw = 0;
		let zTilt = 0;
		let bob = 0;

		if (moving) {
			const ph = time * 7;
			lThG = 0.45 * Math.sin(ph);
			rThG = 0.45 * Math.sin(ph + Math.PI);
			lShinG = 0.25 * (1 - Math.cos(ph));
			rShinG = 0.25 * (1 - Math.cos(ph + Math.PI));
			lShG = 0.4 * Math.sin(ph + Math.PI);
			rShG = 0.4 * Math.sin(ph);
			bob = Math.abs(Math.sin(ph)) * 0.04;
		} else if (sitNow) {
			// Sitting + typing.
			lThG = -1.45;
			rThG = -1.45;
			lShinG = 1.4;
			rShinG = 1.4;
			lShG = -0.7;
			rShG = -0.7;
			lElG = -0.9 + 0.16 * Math.sin(time * 11);
			rElG = -0.9 + 0.16 * Math.sin(time * 11 + 1.6);
			headPitch = 0.12; // looking down at the screen
		} else if (t.behavior === "meeting" && t.speaker) {
			// Gesturing while presenting at the board.
			rShG = -0.7 + 0.5 * Math.sin(time * 3.4);
			rElG = -1.0;
			lShG = 0.08;
			lElG = -0.15;
			headPitch = 0.06 * Math.sin(time * 3.4);
		} else if (t.behavior === "meeting") {
			// Listening: arms down, occasional nod.
			headPitch = 0.05 + 0.05 * Math.sin(time * 1.6);
		} else {
			// Idle standing: subtle sway + glancing around.
			zTilt = Math.sin(time * 1.2) * 0.03;
			headYaw = Math.sin(time * 0.5) * 0.3;
		}

		r.position.y = damp(r.position.y, bob, 6, dt);
		r.rotation.z = damp(r.rotation.z, zTilt, 4, dt);
		if (lThigh.current) lThigh.current.rotation.x = damp(lThigh.current.rotation.x, lThG, 9, dt);
		if (rThigh.current) rThigh.current.rotation.x = damp(rThigh.current.rotation.x, rThG, 9, dt);
		if (lShin.current) lShin.current.rotation.x = damp(lShin.current.rotation.x, lShinG, 9, dt);
		if (rShin.current) rShin.current.rotation.x = damp(rShin.current.rotation.x, rShinG, 9, dt);
		if (lSh.current) lSh.current.rotation.x = damp(lSh.current.rotation.x, lShG, 10, dt);
		if (rSh.current) rSh.current.rotation.x = damp(rSh.current.rotation.x, rShG, 10, dt);
		if (lEl.current) lEl.current.rotation.x = damp(lEl.current.rotation.x, lElG, 10, dt);
		if (rEl.current) rEl.current.rotation.x = damp(rEl.current.rotation.x, rElG, 10, dt);
		if (head.current) {
			head.current.rotation.x = damp(head.current.rotation.x, headPitch, 8, dt);
			head.current.rotation.y = damp(head.current.rotation.y, headYaw, 6, dt);
		}
	});

	const op = dim ? 0.5 : 1;
	const skinMat = <meshStandardMaterial color={SKIN} transparent={dim} opacity={op} />;
	const shirtMat = <meshStandardMaterial color={shirt} transparent={dim} opacity={op} />;
	const pantsMat = <meshStandardMaterial color={PANTS} transparent={dim} opacity={op} />;

	return (
		<group
			ref={root}
			scale={isCoordinator ? 1.14 : 1}
			onClick={(e) => {
				e.stopPropagation();
				onSelect(agent.agentName);
			}}
			onPointerOver={(e) => {
				e.stopPropagation();
				setHovered(true);
				document.body.style.cursor = "pointer";
			}}
			onPointerOut={() => {
				setHovered(false);
				document.body.style.cursor = "auto";
			}}
		>
			<group ref={pelvis} position={[0, HIP_STAND, 0]}>
				{/* Hips */}
				<mesh position={[0, 0, 0]} castShadow>
					<boxGeometry args={[0.5, 0.26, 0.3]} />
					{pantsMat}
				</mesh>
				{/* Left leg */}
				<group ref={lThigh} position={[-0.13, 0, 0]}>
					<mesh position={[0, -THIGH / 2, 0]} castShadow>
						<boxGeometry args={[0.22, THIGH, 0.28]} />
						{pantsMat}
					</mesh>
					<group ref={lShin} position={[0, -THIGH, 0]}>
						<mesh position={[0, -SHIN / 2, 0]} castShadow>
							<boxGeometry args={[0.2, SHIN, 0.26]} />
							{pantsMat}
						</mesh>
						<mesh position={[0, -SHIN + 0.02, 0.07]} castShadow>
							<boxGeometry args={[0.22, 0.1, 0.34]} />
							<meshStandardMaterial color="#15171c" transparent={dim} opacity={op} />
						</mesh>
					</group>
				</group>
				{/* Right leg */}
				<group ref={rThigh} position={[0.13, 0, 0]}>
					<mesh position={[0, -THIGH / 2, 0]} castShadow>
						<boxGeometry args={[0.22, THIGH, 0.28]} />
						{pantsMat}
					</mesh>
					<group ref={rShin} position={[0, -THIGH, 0]}>
						<mesh position={[0, -SHIN / 2, 0]} castShadow>
							<boxGeometry args={[0.2, SHIN, 0.26]} />
							{pantsMat}
						</mesh>
						<mesh position={[0, -SHIN + 0.02, 0.07]} castShadow>
							<boxGeometry args={[0.22, 0.1, 0.34]} />
							<meshStandardMaterial color="#15171c" transparent={dim} opacity={op} />
						</mesh>
					</group>
				</group>
				{/* Torso */}
				<mesh position={[0, 0.36, 0]} castShadow>
					<boxGeometry args={[0.55, 0.7, 0.3]} />
					<meshStandardMaterial
						color={shirt}
						emissive={shirt}
						emissiveIntensity={hovered ? 0.3 : 0.05}
						transparent={dim}
						opacity={op}
					/>
				</mesh>
				{/* Name-color accent stripe across the chest */}
				<mesh position={[0, 0.5, 0.16]}>
					<boxGeometry args={[0.56, 0.12, 0.02]} />
					<meshStandardMaterial color={accent} transparent={dim} opacity={op} />
				</mesh>
				{/* Left arm */}
				<group ref={lSh} position={[-0.36, 0.6, 0]}>
					<mesh position={[0, -0.17, 0]} castShadow>
						<boxGeometry args={[0.15, 0.34, 0.22]} />
						{shirtMat}
					</mesh>
					<group ref={lEl} position={[0, -0.34, 0]}>
						<mesh position={[0, -0.16, 0]} castShadow>
							<boxGeometry args={[0.13, 0.32, 0.2]} />
							{skinMat}
						</mesh>
					</group>
				</group>
				{/* Right arm (holds the role prop) */}
				<group ref={rSh} position={[0.36, 0.6, 0]}>
					<mesh position={[0, -0.17, 0]} castShadow>
						<boxGeometry args={[0.15, 0.34, 0.22]} />
						{shirtMat}
					</mesh>
					<group ref={rEl} position={[0, -0.34, 0]}>
						<mesh position={[0, -0.16, 0]} castShadow>
							<boxGeometry args={[0.13, 0.32, 0.2]} />
							{skinMat}
						</mesh>
						<Prop kind={kit.prop} dim={dim} op={op} />
					</group>
				</group>
				{/* Head (wears the role hat) */}
				<group ref={head} position={[0, 0.84, 0]}>
					<mesh castShadow>
						<boxGeometry args={[0.45, 0.45, 0.45]} />
						{skinMat}
					</mesh>
					<mesh position={[-0.1, 0.04, 0.23]}>
						<boxGeometry args={[0.07, 0.07, 0.02]} />
						<meshStandardMaterial color="#222" />
					</mesh>
					<mesh position={[0.1, 0.04, 0.23]}>
						<boxGeometry args={[0.07, 0.07, 0.02]} />
						<meshStandardMaterial color="#222" />
					</mesh>
					<Hat kind={kit.hat} color={shirt} dim={dim} op={op} />
				</group>
			</group>

			{/* Speech bubble — the handoff the sender is communicating. */}
			{behavior === "meeting" && meeting?.speech ? (
				<Html position={[0, 2.55, 0]} center distanceFactor={9} zIndexRange={LABEL_Z_RANGE}>
					<div
						style={{
							fontFamily: "ui-sans-serif, system-ui, sans-serif",
							fontSize: 12,
							fontWeight: 600,
							color: "#1a1a18",
							background: "#fdfbf5",
							border: `2px solid ${accent}`,
							borderRadius: 10,
							padding: "5px 9px",
							maxWidth: 190,
							lineHeight: 1.3,
							boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
							pointerEvents: "none",
						}}
					>
						{meeting.speech}
					</div>
				</Html>
			) : null}

			{/* Name + role + state label */}
			<Html position={[0, 2.1, 0]} center distanceFactor={10} zIndexRange={LABEL_Z_RANGE}>
				<div
					style={{
						fontFamily: "ui-monospace, monospace",
						fontSize: 12,
						fontWeight: 700,
						color: accent,
						background: "rgba(10,11,13,0.85)",
						border: `1px solid ${accent}`,
						borderRadius: 6,
						padding: "2px 7px",
						whiteSpace: "nowrap",
						transform: hovered ? "scale(1.08)" : "scale(1)",
						pointerEvents: "none",
					}}
				>
					{agent.agentName}
					<span style={{ color: shirt, marginLeft: 6, fontWeight: 600 }}>{kit.label}</span>
					<span style={{ color: state3d(agent.state).color, marginLeft: 6, fontWeight: 600 }}>
						{behavior === "meeting" ? "Meeting" : state3d(agent.state).label}
					</span>
				</div>
			</Html>
		</group>
	);
}

// --- Desk (furniture only; the actor sits/stands separately) ----------------

function Desk({ agent, position }: { agent: AgentSession; position: Vec3 }): JSX.Element {
	const screen = state3d(agent.state).color;
	const active = agent.state === "working" || agent.state === "booting";
	const team = roleKit(agent.capability).color;

	return (
		<group position={position}>
			{/* Table top */}
			<mesh position={[0, 0.92, 0]} castShadow receiveShadow>
				<boxGeometry args={[1.5, 0.08, 0.85]} />
				<meshStandardMaterial color={WOOD_TABLE} />
			</mesh>
			{/* Role-colored front fascia (ties the desk to the agent's team) */}
			<mesh position={[0, 0.74, 0.42]}>
				<boxGeometry args={[1.5, 0.28, 0.03]} />
				<meshStandardMaterial color={team} />
			</mesh>
			{([
				[-0.66, -0.34],
				[0.66, -0.34],
				[-0.66, 0.34],
				[0.66, 0.34],
			] as const).map(([x, z]) => (
				<mesh key={`${x},${z}`} position={[x, 0.46, z]}>
					<boxGeometry args={[0.08, 0.92, 0.08]} />
					<meshStandardMaterial color={WOOD_TABLE_DARK} />
				</mesh>
			))}
			{/* Monitor */}
			<mesh position={[0, 1.0, -0.28]}>
				<boxGeometry args={[0.06, 0.16, 0.06]} />
				<meshStandardMaterial color="#15171c" />
			</mesh>
			<mesh position={[0, 0.97, -0.28]}>
				<boxGeometry args={[0.22, 0.03, 0.12]} />
				<meshStandardMaterial color="#15171c" />
			</mesh>
			<mesh position={[0, 1.32, -0.3]} castShadow>
				<boxGeometry args={[0.66, 0.44, 0.05]} />
				<meshStandardMaterial color="#15171c" />
			</mesh>
			<mesh position={[0, 1.32, -0.272]}>
				<boxGeometry args={[0.6, 0.38, 0.02]} />
				<meshStandardMaterial color={screen} emissive={screen} emissiveIntensity={active ? 0.85 : 0.4} />
			</mesh>
			{/* Keyboard, mouse, papers */}
			<mesh position={[0, 0.97, 0.06]}>
				<boxGeometry args={[0.5, 0.03, 0.16]} />
				<meshStandardMaterial color="#1c1e24" />
			</mesh>
			<mesh position={[0.32, 0.97, 0.08]}>
				<boxGeometry args={[0.08, 0.03, 0.12]} />
				<meshStandardMaterial color="#1c1e24" />
			</mesh>
			<mesh position={[-0.38, 0.97, 0.1]}>
				<boxGeometry args={[0.2, 0.02, 0.26]} />
				<meshStandardMaterial color="#e8e6df" />
			</mesh>
			{/* Office chair */}
			<group position={[0, 0, 0.78]}>
				<mesh position={[0, 0.5, 0]} castShadow>
					<boxGeometry args={[0.5, 0.08, 0.5]} />
					<meshStandardMaterial color={CHAIR} />
				</mesh>
				<mesh position={[0, 0.84, 0.22]} castShadow>
					<boxGeometry args={[0.5, 0.62, 0.08]} />
					<meshStandardMaterial color={CHAIR} />
				</mesh>
				<mesh position={[0, 0.27, 0]}>
					<boxGeometry args={[0.08, 0.46, 0.08]} />
					<meshStandardMaterial color="#15171c" />
				</mesh>
				<mesh position={[0, 0.06, 0]}>
					<boxGeometry args={[0.5, 0.05, 0.5]} />
					<meshStandardMaterial color="#15171c" />
				</mesh>
			</group>
		</group>
	);
}

// --- Coordinator corner office (head of the room, facing the team) -----------

/**
 * The coordinator's executive station: a rug, a wide desk with a role-colored
 * fascia and a "DIRECTOR" nameplate, set at the head of the room. The group is
 * rotated 180° so the desk front (nameplate + monitor for the team) faces +z
 * toward the workforce; the coordinator presides standing just behind it.
 */
function CoordinatorOffice({ position }: { position: Vec3 }): JSX.Element {
	const gold = ROLE_KITS.coordinator?.color ?? "#f5b301";
	return (
		<group position={position} rotation={[0, Math.PI, 0]}>
			{/* Rug */}
			<mesh position={[0, 0.02, 0]} receiveShadow>
				<boxGeometry args={[3.6, 0.04, 2.8]} />
				<meshStandardMaterial color={RUG} />
			</mesh>
			<mesh position={[0, 0.03, 0]}>
				<boxGeometry args={[3.0, 0.04, 2.2]} />
				<meshStandardMaterial color="#8e4a4a" />
			</mesh>
			{/* Wide executive desk */}
			<mesh position={[0, 0.98, 0]} castShadow receiveShadow>
				<boxGeometry args={[2.2, 0.12, 1.1]} />
				<meshStandardMaterial color={WOOD_TABLE} />
			</mesh>
			<mesh position={[0, 0.62, 0.55]}>
				<boxGeometry args={[2.2, 0.64, 0.06]} />
				<meshStandardMaterial color={WOOD_TABLE_DARK} />
			</mesh>
			<mesh position={[0, 0.78, 0.58]}>
				<boxGeometry args={[2.2, 0.16, 0.02]} />
				<meshStandardMaterial color={gold} />
			</mesh>
			{/* Monitor (faces the team, +z before rotation → -z after) */}
			<mesh position={[0, 1.36, -0.34]} castShadow>
				<boxGeometry args={[0.8, 0.5, 0.05]} />
				<meshStandardMaterial color="#15171c" />
			</mesh>
			{/* Executive chair */}
			<group position={[0, 0, -0.85]}>
				<mesh position={[0, 0.52, 0]} castShadow>
					<boxGeometry args={[0.6, 0.1, 0.6]} />
					<meshStandardMaterial color="#1b2233" />
				</mesh>
				<mesh position={[0, 0.95, -0.26]} castShadow>
					<boxGeometry args={[0.6, 0.8, 0.1]} />
					<meshStandardMaterial color="#1b2233" />
				</mesh>
			</group>
			{/* DIRECTOR nameplate on the desk front, facing the team */}
			<Html position={[0, 1.12, -0.6]} center distanceFactor={11} zIndexRange={LABEL_Z_RANGE}>
				<div
					style={{
						fontFamily: "ui-monospace, monospace",
						fontSize: 12,
						fontWeight: 800,
						letterSpacing: "0.12em",
						color: gold,
						background: "rgba(10,11,13,0.85)",
						border: `1px solid ${gold}`,
						borderRadius: 6,
						padding: "2px 8px",
						whiteSpace: "nowrap",
						pointerEvents: "none",
					}}
				>
					DIRECTOR
				</div>
			</Html>
		</group>
	);
}

// --- Whiteboard (the meeting / brainstorming spot) --------------------------

/** A free-standing whiteboard agents gather at; panel faces +x (into the room). */
function Whiteboard({ position, busy }: { position: Vec3; busy: boolean }): JSX.Element {
	return (
		<group position={position}>
			{/* Board panel (thin in x, faces +x) */}
			<mesh position={[0, 1.5, 0]} castShadow>
				<boxGeometry args={[0.08, 1.2, 1.9]} />
				<meshStandardMaterial color="#f4f4f0" />
			</mesh>
			{/* Frame legs */}
			<mesh position={[0, 0.45, -0.8]}>
				<boxGeometry args={[0.08, 1.0, 0.08]} />
				<meshStandardMaterial color="#5b4632" />
			</mesh>
			<mesh position={[0, 0.45, 0.8]}>
				<boxGeometry args={[0.08, 1.0, 0.08]} />
				<meshStandardMaterial color="#5b4632" />
			</mesh>
			{/* Scribbles on the board */}
			<mesh position={[0.05, 1.7, 0.1]}>
				<boxGeometry args={[0.02, 0.06, 1.2]} />
				<meshStandardMaterial color={busy ? "#fb4b38" : "#c9c4ba"} />
			</mesh>
			<mesh position={[0.05, 1.45, -0.1]}>
				<boxGeometry args={[0.02, 0.05, 0.9]} />
				<meshStandardMaterial color="#9aa0a8" />
			</mesh>
			<Html
				position={[0.06, 2.25, 0]}
				center
				distanceFactor={12}
				rotation={[0, Math.PI / 2, 0]}
				zIndexRange={LABEL_Z_RANGE}
			>
				<div
					style={{
						fontFamily: "ui-sans-serif, system-ui, sans-serif",
						fontSize: 12,
						fontWeight: 800,
						letterSpacing: "0.08em",
						color: busy ? "#fb4b38" : "#6b7188",
						pointerEvents: "none",
						whiteSpace: "nowrap",
					}}
				>
					STANDUP
				</div>
			</Html>
		</group>
	);
}

// --- Room (floor, walls) + decorations --------------------------------------

function Floor({ halfX, halfZ }: { halfX: number; halfZ: number }): JSX.Element {
	const depth = 1.15;
	const planks: JSX.Element[] = [];
	let i = 0;
	for (let z = -halfZ + depth / 2; z < halfZ; z += depth) {
		planks.push(
			<mesh key={i} position={[0, 0, z]} receiveShadow>
				<boxGeometry args={[halfX * 2, 0.04, depth - 0.04]} />
				<meshStandardMaterial color={i % 2 === 0 ? PLANK_A : PLANK_B} />
			</mesh>,
		);
		i++;
	}
	return <group>{planks}</group>;
}

function Walls({ halfX, halfZ }: { halfX: number; halfZ: number }): JSX.Element {
	const h = 4;
	return (
		<group>
			<mesh position={[0, h / 2, -halfZ]} receiveShadow>
				<boxGeometry args={[halfX * 2, h, 0.3]} />
				<meshStandardMaterial color={WALL} />
			</mesh>
			<mesh position={[-halfX, h / 2, 0]} receiveShadow>
				<boxGeometry args={[0.3, h, halfZ * 2]} />
				<meshStandardMaterial color={WALL} />
			</mesh>
			<mesh position={[halfX, h / 2, 0]} receiveShadow>
				<boxGeometry args={[0.3, h, halfZ * 2]} />
				<meshStandardMaterial color={WALL} />
			</mesh>
		</group>
	);
}

/** A daylight window inset on a wall: glowing sky pane in a wood frame. */
function Window({ position, rotationY = 0 }: { position: Vec3; rotationY?: number }): JSX.Element {
	return (
		<group position={position} rotation={[0, rotationY, 0]}>
			<mesh>
				<boxGeometry args={[1.7, 1.4, 0.06]} />
				<meshStandardMaterial color="#3a2c1f" />
			</mesh>
			<mesh position={[0, 0, 0.04]}>
				<boxGeometry args={[1.5, 1.2, 0.04]} />
				<meshStandardMaterial color={SKY} emissive={SKY} emissiveIntensity={0.6} />
			</mesh>
			{/* Muntins */}
			<mesh position={[0, 0, 0.06]}>
				<boxGeometry args={[0.05, 1.2, 0.02]} />
				<meshStandardMaterial color="#3a2c1f" />
			</mesh>
			<mesh position={[0, 0, 0.06]}>
				<boxGeometry args={[1.5, 0.05, 0.02]} />
				<meshStandardMaterial color="#3a2c1f" />
			</mesh>
		</group>
	);
}

/** A small framed poster on a wall. */
function Poster({
	position,
	rotationY = 0,
	color,
}: {
	position: Vec3;
	rotationY?: number;
	color: string;
}): JSX.Element {
	return (
		<group position={position} rotation={[0, rotationY, 0]}>
			<mesh>
				<boxGeometry args={[0.9, 1.2, 0.04]} />
				<meshStandardMaterial color="#0f1118" />
			</mesh>
			<mesh position={[0, 0, 0.03]}>
				<boxGeometry args={[0.78, 1.08, 0.02]} />
				<meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} />
			</mesh>
		</group>
	);
}

function Plant({ position }: { position: Vec3 }): JSX.Element {
	return (
		<group position={position}>
			<mesh position={[0, 0.18, 0]} castShadow>
				<boxGeometry args={[0.34, 0.36, 0.34]} />
				<meshStandardMaterial color="#b5651d" />
			</mesh>
			<mesh position={[0, 0.5, 0]} castShadow>
				<boxGeometry args={[0.1, 0.3, 0.1]} />
				<meshStandardMaterial color="#3f7d2e" />
			</mesh>
			<mesh position={[-0.12, 0.62, 0]} castShadow>
				<boxGeometry args={[0.2, 0.12, 0.2]} />
				<meshStandardMaterial color="#4caf50" />
			</mesh>
			<mesh position={[0.12, 0.66, 0.04]} castShadow>
				<boxGeometry args={[0.18, 0.12, 0.18]} />
				<meshStandardMaterial color="#5fbf57" />
			</mesh>
		</group>
	);
}

function TrashBin({ position }: { position: Vec3 }): JSX.Element {
	return (
		<mesh position={[position[0], 0.3, position[2]]} castShadow>
			<boxGeometry args={[0.4, 0.6, 0.4]} />
			<meshStandardMaterial color="#8b2622" />
		</mesh>
	);
}

function WallClock({ position }: { position: Vec3 }): JSX.Element {
	return (
		<group position={position}>
			<mesh rotation={[Math.PI / 2, 0, 0]}>
				<cylinderGeometry args={[0.32, 0.32, 0.05, 24]} />
				<meshStandardMaterial color="#f4f4f0" />
			</mesh>
			<mesh position={[0, 0.08, 0.04]}>
				<boxGeometry args={[0.03, 0.16, 0.02]} />
				<meshStandardMaterial color="#222" />
			</mesh>
			<mesh position={[0.06, 0, 0.04]}>
				<boxGeometry args={[0.12, 0.03, 0.02]} />
				<meshStandardMaterial color="#222" />
			</mesh>
		</group>
	);
}

function RoadmapBoard({ position }: { position: Vec3 }): JSX.Element {
	return (
		<group position={position}>
			<mesh>
				<boxGeometry args={[1.7, 1.1, 0.08]} />
				<meshStandardMaterial color="#f4f4f0" />
			</mesh>
			<Html position={[0, 0.42, 0.06]} center distanceFactor={11} zIndexRange={LABEL_Z_RANGE}>
				<div
					style={{
						fontFamily: "ui-monospace, monospace",
						fontSize: 13,
						fontWeight: 800,
						letterSpacing: "0.08em",
						color: "#444",
						pointerEvents: "none",
						whiteSpace: "nowrap",
					}}
				>
					ROADMAP
				</div>
			</Html>
		</group>
	);
}

// --- Controls ---------------------------------------------------------------

/** FPS walk-around: pointer-lock mouse-look + WASD movement at eye height. */
function FpsControls(): JSX.Element {
	const { camera } = useThree();
	const keys = useRef<Record<string, boolean>>({});

	useEffect(() => {
		camera.position.set(0, 1.7, 6);
		const down = (e: KeyboardEvent) => {
			keys.current[e.code] = true;
		};
		const up = (e: KeyboardEvent) => {
			keys.current[e.code] = false;
		};
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
		};
	}, [camera]);

	useFrame((_, dt) => {
		const speed = 6 * Math.min(dt, 0.05);
		const front = new THREE.Vector3();
		camera.getWorldDirection(front);
		front.y = 0;
		front.normalize();
		const right = new THREE.Vector3().crossVectors(front, new THREE.Vector3(0, 1, 0)).normalize();
		const move = new THREE.Vector3();
		if (keys.current.KeyW) move.add(front);
		if (keys.current.KeyS) move.sub(front);
		if (keys.current.KeyD) move.add(right);
		if (keys.current.KeyA) move.sub(right);
		if (move.lengthSq() > 0) {
			move.normalize().multiplyScalar(speed);
			camera.position.add(move);
			camera.position.y = 1.7;
		}
	});

	return <PointerLockControls />;
}

// --- Scene + screen ---------------------------------------------------------

/** Grid-arrange the workforce in rows; returns positions + room half-extents. */
function layout(n: number): { positions: Vec3[]; halfX: number; halfZ: number } {
	const cols = Math.ceil(Math.sqrt(n));
	const rows = Math.ceil(n / cols);
	const sx = 3.6;
	const sz = 3.4;
	const positions: Vec3[] = [];
	for (let i = 0; i < n; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		positions.push([(col - (cols - 1) / 2) * sx, 0, (row - (rows - 1) / 2) * sz]);
	}
	const halfX = Math.max(8, (cols * sx) / 2 + 3);
	// Extra back depth so the coordinator's corner office fits behind the grid.
	const halfZ = Math.max(9, (rows * sz) / 2 + 5);
	return { positions, halfX, halfZ };
}

/** Active-handoff window: an agent is "in a meeting" this long after a handoff. */
const MEETING_WINDOW_MS = 45_000;
const MAX_MEETING = 6;

function Scene({
	agents,
	handoffs,
	now,
	onSelect,
	fps,
}: {
	agents: AgentSession[];
	handoffs: Handoff[];
	now: number;
	onSelect: (name: string) => void;
	fps: boolean;
}): JSX.Element {
	// The coordinator gets a corner office; everyone else fills the grid.
	const coordinator = agents.find((a) => a.capability === "coordinator") ?? null;
	const workers = coordinator ? agents.filter((a) => a !== coordinator) : agents;

	const { positions, halfX, halfZ } = layout(Math.max(workers.length, 1));
	const boardX = -(halfX - 1.1);
	const boardZ = 0;

	// Coordinator office at the head of the room (back-center), facing the team.
	const coordZ = -(halfZ - 1.8);
	const coordDeskPos: Vec3 = [0, 0, coordZ];
	const coordStation: Station = {
		pos: [0, 0, coordZ - 0.95],
		faceX: 0,
		faceZ: coordZ + 10,
		sit: false,
	};

	// Which agents are mid-handoff → gather at the whiteboard, and who's speaking.
	const present = new Set(agents.map((a) => a.agentName));
	const meetingOrder: string[] = [];
	const speech = new Map<string, { text: string | null; speaker: boolean }>();
	for (const h of handoffs) {
		if (now - Date.parse(h.createdAt) > MEETING_WINDOW_MS) continue;
		if (present.has(h.from)) {
			if (!meetingOrder.includes(h.from)) meetingOrder.push(h.from);
			if (!speech.has(h.from))
				speech.set(h.from, { text: `${handoffVerb(h.type)}: ${h.subject}`, speaker: true });
		}
		if (present.has(h.to)) {
			if (!meetingOrder.includes(h.to)) meetingOrder.push(h.to);
			if (!speech.has(h.to)) speech.set(h.to, { text: null, speaker: false });
		}
	}
	const meetingSet = meetingOrder.slice(0, MAX_MEETING);

	/** Slot in a fan in front of the whiteboard, facing the board. */
	function meetingSlot(i: number, n: number): Vec3 {
		const R = 2.5;
		const spread = n <= 1 ? 0 : Math.min(Math.PI * 0.62, 0.4 + n * 0.18);
		const a = n <= 1 ? 0 : -spread / 2 + spread * (i / (n - 1));
		return [boardX + R * Math.cos(a), 0, boardZ + R * Math.sin(a)];
	}

	/** Build an Actor for one agent, resolving meeting vs station vs desk. */
	function renderActor(a: AgentSession, deskPos: Vec3, station: Station | null): JSX.Element {
		const idx = meetingSet.indexOf(a.agentName);
		const inMeeting = idx >= 0;
		const behavior: Behavior = inMeeting ? "meeting" : baseBehavior(a.state);
		const sp = speech.get(a.agentName);
		const meeting: MeetingInfo | null = inMeeting
			? {
					pos: meetingSlot(idx, meetingSet.length),
					faceX: boardX,
					faceZ: boardZ,
					speech: sp?.text ?? null,
					speaker: sp?.speaker ?? false,
				}
			: null;
		return (
			<Actor
				key={`actor-${a.id}`}
				agent={a}
				deskPos={deskPos}
				behavior={behavior}
				meeting={meeting}
				station={station}
				onSelect={onSelect}
			/>
		);
	}

	return (
		<>
			<ambientLight intensity={0.62} />
			<directionalLight position={[6, 12, 8]} intensity={0.85} castShadow />
			<pointLight position={[-6, 8, -6]} intensity={0.22} color="#f5402d" />
			<pointLight position={[0, 6, 6]} intensity={0.3} color="#ffd9a0" />
			<hemisphereLight args={[SKY, "#3a2c1f", 0.4]} />

			<Floor halfX={halfX} halfZ={halfZ} />
			<Walls halfX={halfX} halfZ={halfZ} />

			{/* Worker desks + actors */}
			{workers.map((a, i) => (
				<Desk key={`desk-${a.id}`} agent={a} position={positions[i] ?? [0, 0, 0]} />
			))}
			{workers.map((a, i) => renderActor(a, positions[i] ?? [0, 0, 0], null))}

			{/* Coordinator corner office */}
			{coordinator ? (
				<>
					<CoordinatorOffice position={coordDeskPos} />
					{renderActor(coordinator, coordDeskPos, coordStation)}
				</>
			) : null}

			<Whiteboard position={[boardX, 0, boardZ]} busy={meetingSet.length > 0} />

			{/* Decorations against the walls */}
			<Window position={[-halfX * 0.45, 2.4, -halfZ + 0.18]} />
			<Window position={[halfX * 0.45, 2.4, -halfZ + 0.18]} />
			<Poster position={[-halfX + 0.2, 2.2, halfZ * 0.3]} rotationY={Math.PI / 2} color="#4f86f7" />
			<Poster position={[halfX - 0.2, 2.2, -halfZ * 0.2]} rotationY={-Math.PI / 2} color="#34d399" />
			<Plant position={[-halfX + 1.4, 0, halfZ - 2]} />
			<Plant position={[halfX - 1.6, 0, halfZ - 1.4]} />
			<TrashBin position={[halfX - 1.2, 0, halfZ - 0.8]} />
			<WallClock position={[-2.6, 2.7, -halfZ + 0.22]} />
			<RoadmapBoard position={[2.8, 2.3, -halfZ + 0.3]} />

			{fps ? (
				<FpsControls />
			) : (
				<OrbitControls enablePan minDistance={4} maxDistance={halfZ * 2.4} maxPolarAngle={Math.PI / 2.1} />
			)}
		</>
	);
}

/** A control-hint row in the office info panel: small flat icon + label. */
function Hint({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }): JSX.Element {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 7 }}>
			<Icon size={14} style={{ flex: "0 0 auto" }} />
			<span>{children}</span>
		</div>
	);
}

/** A small colored dot used in the legend keys. */
function Dot({ color }: { color: string }): JSX.Element {
	return (
		<span
			style={{
				width: 9,
				height: 9,
				borderRadius: "50%",
				background: color,
				display: "inline-block",
				flex: "0 0 auto",
			}}
		/>
	);
}

export function OfficeScreen({
	agents,
	onSelect,
}: {
	agents: AgentSession[];
	onSelect: (name: string) => void;
}): JSX.Element {
	const [fps, setFps] = useState(false);
	const { data: handoffs } = usePolling(getHandoffs, 5000);
	// Tick so meeting windows + completed-agent grace expire between polls.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = window.setInterval(() => setNow(Date.now()), 5000);
		return () => window.clearInterval(t);
	}, []);

	// Only agents still "in the building" get a desk (see visibleInOffice).
	const present = useMemo(() => agents.filter((a) => visibleInOffice(a, now)), [agents, now]);
	// Distinct roles currently present → a compact role key in the legend.
	const presentRoles = useMemo(() => {
		const seen = new Set<string>();
		const out: { cap: string; kit: RoleKit }[] = [];
		for (const a of present) {
			if (seen.has(a.capability)) continue;
			seen.add(a.capability);
			out.push({ cap: a.capability, kit: roleKit(a.capability) });
		}
		return out;
	}, [present]);

	return (
		<div>
			<div className="page-head">
				<h1 className="page-title">
						<PageIcon icon={IconOffice} /> Office
					</h1>
				<p className="page-sub">
					Agents act out their work by role: each wears a kit (the coordinator presides from the
					corner office), idle agents stand, working agents sit and type, and handoffs meet at the
					whiteboard. Finished agents linger briefly, then leave. Click an avatar for detail.
				</p>
			</div>

			<div
				className="card"
				style={{
					padding: 0,
					overflow: "hidden",
					position: "relative",
					height: "calc(100vh - 230px)",
					minHeight: 460,
				}}
			>
				{present.length === 0 ? (
					<div className="empty" style={{ paddingTop: 140 }}>
						The office is empty — spawn an agent to populate it.
					</div>
				) : (
					<>
						<Canvas
							shadows
							camera={{ position: [0, 7, 13], fov: 45 }}
							style={{ background: SKY }}
						>
							<Scene
								agents={present}
								handoffs={handoffs ?? []}
								now={now}
								onSelect={onSelect}
								fps={fps}
							/>
						</Canvas>

						{/* Info panel (top-left) */}
						<div
							style={{
								position: "absolute",
								top: 14,
								left: 14,
								zIndex: PANEL_Z,
								background: "rgba(10,11,13,0.82)",
								border: "1px solid var(--border)",
								borderRadius: 10,
								padding: "12px 14px",
								fontSize: 13,
								color: "var(--text)",
								minWidth: 188,
								backdropFilter: "blur(4px)",
							}}
						>
							<div
								style={{
									fontWeight: 800,
									marginBottom: 8,
									display: "flex",
									alignItems: "center",
									gap: 7,
								}}
							>
								<IconOffice size={16} /> The Office
							</div>
							<div
								className="dim"
								style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}
							>
								<Hint icon={fps ? IconFps : IconOrbit}>
									<b style={{ color: "var(--text)" }}>Mode:</b> {fps ? "FPS" : "Orbit"}
								</Hint>
								{fps ? (
									<>
										<Hint icon={IconKeyboard}>WASD: Move</Hint>
										<Hint icon={IconMouse}>Mouse: Look</Hint>
										<Hint icon={IconKeyboard}>Esc: Release</Hint>
									</>
								) : (
									<>
										<Hint icon={IconMouse}>Mouse: Rotate view</Hint>
										<Hint icon={IconZoom}>Scroll: Zoom</Hint>
										<Hint icon={IconClick}>Click: Select</Hint>
									</>
								)}
							</div>
							<button
								type="button"
								className="btn primary"
								style={{ marginTop: 10, width: "100%" }}
								onClick={() => setFps((v) => !v)}
							>
								{fps ? "Switch to Orbit Mode" : "Switch to FPS Mode"}
							</button>
						</div>

						{/* Status + role legend (bottom-right) */}
						<div
							style={{
								position: "absolute",
								bottom: 14,
								right: 14,
								zIndex: PANEL_Z,
								background: "rgba(10,11,13,0.82)",
								border: "1px solid var(--border)",
								borderRadius: 10,
								padding: "10px 14px",
								fontSize: 12.5,
								color: "var(--text)",
								maxHeight: "calc(100% - 28px)",
								overflowY: "auto",
								backdropFilter: "blur(4px)",
							}}
						>
							<div style={{ fontWeight: 800, marginBottom: 6 }}>State</div>
							{LEGEND.map((s) => (
								<div
									key={s.label}
									style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}
								>
									<Dot color={s.color} />
									{s.label}
								</div>
							))}
							{presentRoles.length > 0 ? (
								<>
									<div
										style={{
											fontWeight: 800,
											margin: "10px 0 6px",
											borderTop: "1px solid var(--border)",
											paddingTop: 8,
										}}
									>
										Roles
									</div>
									{presentRoles.map((r) => (
										<div
											key={r.cap}
											style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}
										>
											<Dot color={r.kit.color} />
											{r.kit.label}
										</div>
									))}
								</>
							) : null}
							<div
								style={{
									fontWeight: 800,
									margin: "10px 0 6px",
									borderTop: "1px solid var(--border)",
									paddingTop: 8,
								}}
							>
								Behavior
							</div>
							<div className="dim" style={{ lineHeight: 1.7 }}>
								<div>Standing — idle</div>
								<div>Sitting &amp; typing — working</div>
								<div>At whiteboard — handing off</div>
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
