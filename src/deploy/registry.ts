/**
 * Deploy target registry — the single place that knows about concrete target
 * classes.
 *
 * Everything else resolves a target by name through {@link getDeployTarget} and
 * then talks only to the {@link DeployTarget} interface, so adding a new target
 * is a one-line registration here plus its adapter file under `./targets/`.
 *
 * Unlike the runtime registry, resolution here has **no silent default
 * fallback**: a deploy is consequential, so an unset target or a typo must fail
 * loudly rather than ship somewhere unintended. The name is resolved from the
 * explicit argument, then `config.deploy.default`; if neither is set, or the
 * resolved name is unknown, a {@link ValidationError} is thrown listing the
 * registered names.
 */

import { ValidationError } from "../errors.ts";
import type { AgentplateConfig } from "../types.ts";
import { DockerGhaTarget } from "./targets/docker-gha.ts";
import type { DeployTarget } from "./types.ts";

/**
 * Name → factory map. Factories return a *fresh* instance per call so targets
 * can never accidentally share mutable state between resolutions. Insertion
 * order here defines the order reported by {@link getDeployTargetNames} and in
 * error messages.
 *
 * Future targets land here as one-liners once their adapter file exists:
 *   ["vercel",    () => new VercelTarget()],     // ./targets/vercel.ts
 *   ["aws",       () => new AwsTarget()],         // ./targets/aws.ts
 *   ["k8s-helm",  () => new K8sHelmTarget()],     // ./targets/k8s-helm.ts
 *   ["onprem",    () => new OnpremTarget()],      // ./targets/onprem.ts
 */
const targets = new Map<string, () => DeployTarget>([["docker-gha", () => new DockerGhaTarget()]]);

/**
 * Resolve a deploy target by name.
 *
 * Lookup order:
 *   1. explicit `name` (e.g. from `--target`),
 *   2. `config.deploy.default`.
 *
 * There is intentionally **no** built-in default: if neither source yields a
 * name, a {@link ValidationError} is thrown listing the registered targets so
 * the operator must choose explicitly. An unknown name throws the same way.
 *
 * @param name - Target id to resolve (e.g. "docker-gha"). Omit to use the config default.
 * @param config - Agentplate config; `config.deploy.default` is the fallback source.
 * @throws {ValidationError} When no name resolves, or the resolved name is unknown.
 * @returns A fresh {@link DeployTarget} instance.
 */
export function getDeployTarget(name?: string, config?: AgentplateConfig): DeployTarget {
	const configDefault = config?.deploy?.default;
	const resolved = name ?? (configDefault !== "" ? configDefault : undefined);
	if (resolved === undefined || resolved === "") {
		throw new ValidationError(
			`No deploy target specified and config.deploy.default is unset. ` +
				`Pass a target name. Available targets: ${getDeployTargetNames().join(", ")}`,
		);
	}
	const factory = targets.get(resolved);
	if (!factory) {
		throw new ValidationError(
			`Unknown deploy target: "${resolved}". Available targets: ${getDeployTargetNames().join(", ")}`,
		);
	}
	return factory();
}

/**
 * Names of all registered deploy targets, in registration order. Used to
 * validate a user-supplied target name and to render the choices in help /
 * errors.
 */
export function getDeployTargetNames(): string[] {
	return [...targets.keys()];
}

/**
 * Return one fresh instance of every registered deploy target. Used by callers
 * that need to enumerate all targets (e.g. doctor preflight, auto-selection by
 * `detect()` confidence).
 */
export function getAllDeployTargets(): DeployTarget[] {
	return [...targets.values()].map((factory) => factory());
}
