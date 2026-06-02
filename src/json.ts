/**
 * Standardized JSON output envelopes for `--json` mode.
 *
 * Every command that supports `--json` should emit exactly one envelope on
 * stdout via {@link jsonOutput} or {@link jsonError}, so machine consumers get a
 * predictable, versioned shape: `{ ok, data? , error? }`.
 */

import { isAgentplateError } from "./errors.ts";

/** Successful JSON envelope. */
export interface JsonSuccess<T> {
	ok: true;
	data: T;
}

/** Error JSON envelope. */
export interface JsonFailure {
	ok: false;
	error: {
		code: string;
		message: string;
	};
}

export type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure;

/** Build (do not print) a success envelope. */
export function jsonSuccess<T>(data: T): JsonSuccess<T> {
	return { ok: true, data };
}

/** Build (do not print) an error envelope from any thrown value. */
export function jsonFailure(error: unknown): JsonFailure {
	if (isAgentplateError(error)) {
		return { ok: false, error: { code: error.code, message: error.message } };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { ok: false, error: { code: "UNKNOWN_ERROR", message } };
}

/** Print a success envelope to stdout. */
export function jsonOutput<T>(data: T): void {
	process.stdout.write(`${JSON.stringify(jsonSuccess(data))}\n`);
}

/** Print an error envelope to stderr. */
export function jsonError(error: unknown): void {
	process.stderr.write(`${JSON.stringify(jsonFailure(error))}\n`);
}
