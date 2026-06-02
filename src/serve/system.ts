/**
 * Host system metrics for the System Monitor screen + bottom status bar.
 *
 * Reads real CPU / memory / disk / uptime of the machine running `agentplate
 * serve` via Node's `os` module and a `df` probe (best-effort; degrades to nulls
 * if a probe fails). CPU load is approximated from the 1-minute load average
 * over the core count — cheap and dependency-free.
 */

import { cpus, freemem, hostname, loadavg, totalmem, uptime } from "node:os";

export interface SystemMetrics {
	cpu: {
		cores: number;
		/** 0..100 utilization estimate from 1-min load average / cores. */
		percent: number;
		loadAvg: [number, number, number];
	};
	memory: {
		usedBytes: number;
		totalBytes: number;
		percent: number;
	};
	disk: {
		usedBytes: number | null;
		totalBytes: number | null;
		percent: number | null;
	};
	uptimeSeconds: number;
	hostname: string;
	platform: string;
}

/** Probe disk usage of the root filesystem via `df -k /` (best-effort). */
async function diskUsage(): Promise<SystemMetrics["disk"]> {
	// `df` is Unix-only; on Windows report unknown rather than erroring (the UI
	// already renders "—" for null disk metrics).
	if (process.platform === "win32") {
		return { usedBytes: null, totalBytes: null, percent: null };
	}
	try {
		const proc = Bun.spawn(["df", "-k", "/"], { stdout: "pipe", stderr: "pipe" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		// Second line: Filesystem 1K-blocks Used Available Capacity ... Mounted
		const line = out.trim().split("\n")[1] ?? "";
		const cols = line.split(/\s+/);
		const totalKb = Number(cols[1]);
		const usedKb = Number(cols[2]);
		if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || totalKb <= 0) {
			return { usedBytes: null, totalBytes: null, percent: null };
		}
		const totalBytes = totalKb * 1024;
		const usedBytes = usedKb * 1024;
		return { usedBytes, totalBytes, percent: Math.round((usedBytes / totalBytes) * 100) };
	} catch {
		return { usedBytes: null, totalBytes: null, percent: null };
	}
}

/** Collect a full system-metrics snapshot. */
export async function collectSystemMetrics(): Promise<SystemMetrics> {
	const cores = cpus().length || 1;
	const la = loadavg();
	const load1 = la[0] ?? 0;
	const cpuPercent = Math.min(100, Math.round((load1 / cores) * 100));

	const total = totalmem();
	const free = freemem();
	const usedMem = total - free;

	const disk = await diskUsage();

	return {
		cpu: {
			cores,
			percent: cpuPercent,
			loadAvg: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
		},
		memory: {
			usedBytes: usedMem,
			totalBytes: total,
			percent: total > 0 ? Math.round((usedMem / total) * 100) : 0,
		},
		disk,
		uptimeSeconds: Math.round(uptime()),
		hostname: hostname(),
		platform: process.platform,
	};
}
