// Minimal data-fetching hook: load once on mount, then re-poll on an interval.
// Returns the latest data, any error, and a loading flag for the first load.
// No external state library — just useState + useEffect.

import { useEffect, useState } from "react";

export interface PollingResult<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
}

/**
 * Poll `fetcher` every `intervalMs`. The `fetcher` is captured once on mount
 * (callers pass a stable module-level function like `getSkills`), so changing
 * inline closures will not retrigger; pass `intervalMs` to tune cadence.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 5000): PollingResult<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			fetcher()
				.then((result) => {
					if (cancelled) return;
					setData(result);
					setError(null);
					setLoading(false);
				})
				.catch((err: unknown) => {
					if (cancelled) return;
					setError(err instanceof Error ? err.message : String(err));
					setLoading(false);
				});
		};
		load();
		const timer = window.setInterval(load, intervalMs);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
		// fetcher is expected to be a stable reference (module-level API fn).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [intervalMs]);

	return { data, error, loading };
}
