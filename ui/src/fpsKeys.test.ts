// Runs under the root `bun test` with real EventTargets (no DOM needed).
// Excluded from the UI tsconfig (its CI job has no bun types).

import { describe, expect, test } from "bun:test";
import { PerspectiveCamera } from "three";
import { PointerLockControls } from "three-stdlib";
import { bindMovementKeys, type PointerLockDoc, pointerLockedTo } from "./fpsKeys.ts";

class FakeDoc extends EventTarget implements PointerLockDoc {
	pointerLockElement: Element | null = null;
	visibilityState = "visible";
}

function key(type: "keydown" | "keyup", code: string): Event {
	return Object.assign(new Event(type), { code });
}

function setup() {
	const win = new EventTarget();
	const doc = new FakeDoc();
	const canvas = {} as Element;
	const keys: Record<string, boolean> = {};
	const unbind = bindMovementKeys(win, doc, keys, () => doc.pointerLockElement === canvas);
	const lock = () => {
		doc.pointerLockElement = canvas;
		doc.dispatchEvent(new Event("pointerlockchange"));
	};
	const unlock = () => {
		doc.pointerLockElement = null;
		doc.dispatchEvent(new Event("pointerlockchange"));
	};
	return { win, doc, keys, unbind, lock, unlock };
}

describe("bindMovementKeys", () => {
	test("keys don't register while the pointer isn't locked to the canvas", () => {
		const { win, keys } = setup();
		win.dispatchEvent(key("keydown", "KeyW"));
		expect(keys.KeyW).toBeUndefined();
	});

	test("keys register while locked and release on keyup", () => {
		const { win, keys, lock } = setup();
		lock();
		win.dispatchEvent(key("keydown", "KeyW"));
		expect(keys.KeyW).toBe(true);
		win.dispatchEvent(key("keyup", "KeyW"));
		expect(keys.KeyW).toBe(false);
	});

	test("a lost keyup (Alt-Tab → window blur) can't leave the camera flying", () => {
		const { win, keys, lock } = setup();
		lock();
		win.dispatchEvent(key("keydown", "KeyW"));
		win.dispatchEvent(new Event("blur"));
		expect(keys.KeyW).toBeUndefined();
	});

	test("releasing pointer lock (Esc) clears held keys", () => {
		const { win, keys, lock, unlock } = setup();
		lock();
		win.dispatchEvent(key("keydown", "KeyD"));
		unlock();
		expect(Object.keys(keys)).toEqual([]);
	});

	test("hiding the tab clears held keys", () => {
		const { win, doc, keys, lock } = setup();
		lock();
		win.dispatchEvent(key("keydown", "KeyA"));
		doc.visibilityState = "hidden";
		doc.dispatchEvent(new Event("visibilitychange"));
		expect(Object.keys(keys)).toEqual([]);
	});

	test("unbind removes listeners and clears state", () => {
		const { win, keys, lock, unbind } = setup();
		lock();
		win.dispatchEvent(key("keydown", "KeyS"));
		unbind();
		expect(Object.keys(keys)).toEqual([]);
		win.dispatchEvent(key("keydown", "KeyS"));
		expect(keys.KeyS).toBeUndefined();
	});
});

// The real controls class drei's <PointerLockControls> wraps: lock() calls
// `requestPointerLock()` on whatever element it was connected to. These pin the
// contract FpsControls relies on — the predicate must compare against that
// same element (drei defaults it to R3F's wrapper <div>, not the <canvas>).
class LockableDoc extends FakeDoc {
	exitPointerLock(): void {
		this.pointerLockElement = null;
		this.dispatchEvent(new Event("pointerlockchange"));
	}
}

function lockable(doc: LockableDoc): Element {
	const el = {
		ownerDocument: doc,
		requestPointerLock(): void {
			doc.pointerLockElement = el;
			doc.dispatchEvent(new Event("pointerlockchange"));
		},
	};
	return el as unknown as Element;
}

describe("pointer lock wiring (real three-stdlib PointerLockControls)", () => {
	function wire(lockOn: "canvas" | "wrapper") {
		const win = new EventTarget();
		const doc = new LockableDoc();
		const canvas = lockable(doc);
		const wrapper = lockable(doc);
		const controls = new PointerLockControls(new PerspectiveCamera());
		controls.connect((lockOn === "canvas" ? canvas : wrapper) as HTMLElement);
		const keys: Record<string, boolean> = {};
		const unbind = bindMovementKeys(win, doc, keys, () => pointerLockedTo(doc, canvas));
		return { win, doc, canvas, controls, keys, unbind };
	}

	test("controls connected to the canvas: lock() → WASD registers", () => {
		const { win, doc, canvas, controls, keys, unbind } = wire("canvas");
		controls.lock();
		expect(pointerLockedTo(doc, canvas)).toBe(true);
		win.dispatchEvent(key("keydown", "KeyW"));
		expect(keys.KeyW).toBe(true);
		controls.unlock();
		expect(Object.keys(keys)).toEqual([]);
		unbind();
		controls.dispose();
	});

	test("controls left on drei's default (wrapper) never satisfy a canvas predicate", () => {
		// The regression: lock lands on the wrapper, so WASD never registers.
		const { win, doc, canvas, controls, keys, unbind } = wire("wrapper");
		controls.lock();
		expect(doc.pointerLockElement).not.toBeNull();
		expect(pointerLockedTo(doc, canvas)).toBe(false);
		win.dispatchEvent(key("keydown", "KeyW"));
		expect(keys.KeyW).toBeUndefined();
		unbind();
		controls.dispose();
	});

	test("pointerLockedTo is false for a null target", () => {
		const doc = new FakeDoc();
		expect(pointerLockedTo(doc, null)).toBe(false);
	});
});
