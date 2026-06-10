/**
 * Single source of truth for the Agentplate CLI version.
 *
 * Kept as a plain constant (not read from package.json at runtime) so the value
 * is available without filesystem access and survives bundling.
 */
export const VERSION = "1.7.0";
