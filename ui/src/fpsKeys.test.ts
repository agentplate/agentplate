// Runs under the root `bun test` with real EventTargets (no DOM needed).
// Excluded from the UI tsconfig (its CI job has no bun types).

import { describe, expect, test } from "bun:test";
import { bindMovementKeys, type PointerLockDoc } from "./fpsKeys.ts";

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
