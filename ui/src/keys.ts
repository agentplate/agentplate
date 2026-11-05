// Stable React keys for lists whose items have no id (e.g. feed rows).
//
// Index keys re-associate DOM/state with the wrong row whenever items are
// prepended or trimmed (the live feed does both). Instead, key each item by its
// content and disambiguate exact duplicates by occurrence count, so a given row
// keeps its key as the list shifts around it.

/** Pair each item with a content-derived key that is unique within the list. */
export function withStableKeys<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
): { item: T; key: string }[] {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const base = keyOf(item);
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return { item, key: n === 0 ? base : `${base}#${n}` };
	});
}

/** Content key for a feed row (`FeedItem` has no id). */
export function feedKey(f: {
	ts: string;
	agent: string;
	label: string;
	summary: string;
	kind?: string;
}): string {
	return `${f.ts}|${f.kind ?? ""}|${f.agent}|${f.label}|${f.summary}`;
}
