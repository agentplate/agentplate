/**
 * Central color + console output control.
 *
 * Wraps `chalk` so color can be disabled globally (via `NO_COLOR`, a non-TTY
 * stdout, or `--quiet`) from one place, and exposes a small palette + a set of
 * semantic printers used across commands for a consistent look.
 */

import chalk from "chalk";

let quiet = false;

/** Enable/disable quiet mode (suppresses non-error output). */
export function setQuiet(value: boolean): void {
	quiet = value;
}

/** Is quiet mode active? */
export function isQuiet(): boolean {
	return quiet;
}

/** Re-export chalk so callers don't import it directly. */
export { chalk };

// Palette ------------------------------------------------------------------
/** Brand color (primary). */
export const brand = chalk.hex("#e07a3f");
/** Accent color (secondary highlights). */
export const accent = chalk.hex("#f0b429");
/** Muted color (de-emphasized text). */
export const muted = chalk.dim;

// Semantic printers --------------------------------------------------------
/** Print a success line (skipped in quiet mode). */
export function printSuccess(message: string): void {
	if (quiet) return;
	process.stdout.write(`${chalk.green("✓")} ${message}\n`);
}

/** Print an informational line (skipped in quiet mode). */
export function printInfo(message: string): void {
	if (quiet) return;
	process.stdout.write(`${message}\n`);
}

/** Print a warning line (skipped in quiet mode). */
export function printWarning(message: string): void {
	if (quiet) return;
	process.stdout.write(`${accent("!")} ${message}\n`);
}

/** Print a de-emphasized hint line (skipped in quiet mode). */
export function printHint(message: string): void {
	if (quiet) return;
	process.stdout.write(`${muted(message)}\n`);
}

/** Print an error line to stderr (always shown). */
export function printError(message: string): void {
	process.stderr.write(`${chalk.red("✗")} ${message}\n`);
}
