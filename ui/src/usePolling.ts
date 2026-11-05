// Minimal data-fetching hook: load once on mount, then re-poll on an interval.
// Returns the latest data, any error, and a loading flag for the first load.
// No external state library — just useState + useEffect.

import { useEffect, useRef, useState } from "react";

export interface PollingResult<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
}

/**
 * Poll `fetcher` every `intervalMs`. Each tick calls the *latest* `fetcher`
 * (held in a ref), so an inline closure like `() => getAgentDetail(name)` is
 * always current without restarting the timer. Callers whose data identity
 * changes (e.g. a different agent) should also remount via a React `key` so
 * the previous subject's data isn't shown while the first new fetch is in flight.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 5000): PollingResult<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const fetcherRef = useRef(fetcher);

	// Runs before the polling effect below (effects run in declaration order).
	useEffect(() => {
		fetcherRef.current = fetcher;
	}, [fetcher]);

	useEffect(() => {
		let cancelled = false;
		const load = () => {
			fetcherRef
				.current()
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
	}, [intervalMs]);

	return { data, error, loading };
}
