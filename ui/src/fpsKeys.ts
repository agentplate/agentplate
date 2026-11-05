// WASD key state for the Office FPS walk-around, kept out of the React/three
// component so it can be unit-tested under `bun test` with plain EventTargets.
//
// Keys only register while the pointer is locked to the 3D canvas (so typing
// "w" elsewhere on the page doesn't fly the camera), and the whole state is
// cleared whenever a keyup could be lost: window blur (Alt-Tab), the tab being
// hidden, or pointer lock being released (Esc).

/** The subset of `document` the binder needs. */
export interface PointerLockDoc extends EventTarget {
	readonly pointerLockElement: Element | null;
	readonly visibilityState?: string;
}

/** A keyboard-ish event: just the physical key code. */
interface CodeEvent extends Event {
	readonly code?: string;
}

/**
 * Track movement keys into `keys` while `isActive()` holds. Returns an unbind
 * function that removes every listener.
 */
export function bindMovementKeys(
	win: EventTarget,
	doc: PointerLockDoc,
	keys: Record<string, boolean>,
	isActive: () => boolean,
): () => void {
	const clear = () => {
		for (const k of Object.keys(keys)) delete keys[k];
	};
	const down = (e: Event) => {
		const code = (e as CodeEvent).code;
		if (code && isActive()) keys[code] = true;
	};
	const up = (e: Event) => {
		const code = (e as CodeEvent).code;
		if (code) keys[code] = false;
	};
	const onVisibility = () => {
		if (doc.visibilityState !== "visible") clear();
	};
	const onLockChange = () => {
		if (!isActive()) clear();
	};
	win.addEventListener("keydown", down);
	win.addEventListener("keyup", up);
	win.addEventListener("blur", clear);
	doc.addEventListener("visibilitychange", onVisibility);
	doc.addEventListener("pointerlockchange", onLockChange);
	return () => {
		win.removeEventListener("keydown", down);
		win.removeEventListener("keyup", up);
		win.removeEventListener("blur", clear);
		doc.removeEventListener("visibilitychange", onVisibility);
		doc.removeEventListener("pointerlockchange", onLockChange);
		clear();
	};
}
