/**
 * Provider catalog — the static knowledge Agentplate has about AI providers.
 *
 * This is the menu the setup wizard presents. It is intentionally code (not
 * config): adding a provider here makes it instantly available in `agentplate
 * setup`, mirroring how Hermes Agent's `select_provider_and_model()` works.
 *
 * A *provider* is an LLM backend with credentials. It is distinct from a
 * *runtime* (the coding-agent CLI that drives workers — see src/runtimes/).
 * `native` providers are reached through the runtime's own auth; `gateway`
 * providers route through a base URL with a bearer token.
 *
 * Agentplate rejects models below `minContextTokens` of context, because
 * multi-step tool-calling agents need room to work (the same 64k floor Hermes
 * enforces).
 */

/** Minimum context window (tokens) Agentplate will accept for an agent model. */
export const MIN_CONTEXT_TOKENS = 64_000;

export interface ProviderModel {
	/** Model id passed to the provider/runtime (e.g. "claude-sonnet-4-6"). */
	id: string;
	/** Human label for the wizard. */
	label: string;
	/** Context window in tokens. */
	contextWindow: number;
}

export interface ProviderSpec {
	/** Unique provider id (key into config.providers). */
	id: string;
	/** Human label for the wizard. */
	label: string;
	/** One-line description. */
	description: string;
	/** `native` = runtime-native auth; `gateway` = base URL + bearer token. */
	kind: "native" | "gateway";
	/** Conventional env var name holding the API key. */
	authEnvVar: string;
	/** Default base URL for gateway providers. */
	defaultBaseUrl?: string;
	/** True if the user must supply a base URL (custom/self-hosted endpoints). */
	requiresBaseUrl?: boolean;
	/** True if this provider does not need an API key (e.g. local Ollama). */
	keyless?: boolean;
	/**
	 * True if this provider can be used via an existing CLI/subscription login
	 * (no API key stored) — e.g. a Claude Pro/Max OAuth session in Claude Code.
	 */
	supportsSubscription?: boolean;
	/** The runtime CLI that provides the subscription login (e.g. "claude"). */
	subscriptionRuntime?: string;
	/** Human label for the subscription option (e.g. "Claude Pro/Max subscription"). */
	subscriptionLabel?: string;
	/** Known models (the wizard offers these; custom ids are always allowed). */
	models: ProviderModel[];
	/** Where to get credentials / docs. */
	docsUrl?: string;
}

/**
 * The catalog. Model lists are a curated starting point, not exhaustive — the
 * wizard always lets the user type a custom model id.
 */
export const PROVIDERS: readonly ProviderSpec[] = [
	{
		id: "anthropic",
		label: "Anthropic",
		description: "Claude models (native Claude Code support)",
		kind: "native",
		authEnvVar: "ANTHROPIC_API_KEY",
		supportsSubscription: true,
		subscriptionRuntime: "claude",
		subscriptionLabel: "Claude Pro/Max subscription (Claude Code login)",
		docsUrl: "https://console.anthropic.com/settings/keys",
		models: [
			{ id: "claude-opus-4-8", label: "Claude Opus 4.8", contextWindow: 200_000 },
			{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextWindow: 200_000 },
			{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", contextWindow: 200_000 },
		],
	},
	{
		id: "openai",
		label: "OpenAI",
		description: "GPT-5 series — frontier and coding-optimized models (Codex)",
		kind: "gateway",
		authEnvVar: "OPENAI_API_KEY",
		defaultBaseUrl: "https://api.openai.com/v1",
		supportsSubscription: true,
		subscriptionRuntime: "codex",
		subscriptionLabel: "ChatGPT/Codex subscription (codex login)",
		docsUrl: "https://platform.openai.com/api-keys",
		// The development-focused slice of the Codex model catalog (codex-cli 0.128).
		// gpt-5.5 leads (frontier coding); the codex/spark variants are the
		// coding-optimized line. Spark is Codex-subscription only (not in the public
		// API), so prefer it with the `codex` runtime. The wizard always allows a
		// custom model id, so this is a curated starting point, not the full list.
		models: [
			{ id: "gpt-5.5", label: "GPT-5.5 (frontier coding)", contextWindow: 272_000 },
			{ id: "gpt-5.4", label: "GPT-5.4 (everyday coding)", contextWindow: 272_000 },
			{ id: "gpt-5.4-mini", label: "GPT-5.4 Mini (fast, low-cost)", contextWindow: 272_000 },
			{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex (coding-optimized)", contextWindow: 272_000 },
			{
				id: "gpt-5.3-codex-spark",
				label: "GPT-5.3 Codex Spark (ultra-fast, Codex login only)",
				contextWindow: 128_000,
			},
		],
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		description: "Free development models behind one OpenAI-compatible gateway",
		kind: "gateway",
		authEnvVar: "OPENROUTER_API_KEY",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		docsUrl: "https://openrouter.ai/models?max_price=0",
		// Curated free (`:free`) coding models verified against the OpenRouter API.
		// Free tiers are rate-limited and may change; any paid model id can still be
		// typed at the prompt. qwen3-coder leads (coding-specialized, 1M context).
		models: [
			{ id: "qwen/qwen3-coder:free", label: "Qwen3 Coder (free)", contextWindow: 1_000_000 },
			{ id: "moonshotai/kimi-k2.6:free", label: "Kimi K2.6 (free)", contextWindow: 262_144 },
			{
				id: "qwen/qwen3-next-80b-a3b-instruct:free",
				label: "Qwen3 Next 80B (free)",
				contextWindow: 262_144,
			},
			{ id: "z-ai/glm-4.5-air:free", label: "GLM 4.5 Air (free)", contextWindow: 131_072 },
			{ id: "openai/gpt-oss-120b:free", label: "GPT-OSS 120B (free)", contextWindow: 131_072 },
			{
				id: "meta-llama/llama-3.3-70b-instruct:free",
				label: "Llama 3.3 70B (free)",
				contextWindow: 131_072,
			},
		],
	},
	{
		id: "opencode-zen",
		label: "OpenCode Zen",
		description: "Free development models (MiniMax 2.5, GLM, Kimi, Qwen, DeepSeek…)",
		kind: "gateway",
		authEnvVar: "OPENCODE_API_KEY",
		defaultBaseUrl: "https://opencode.ai/zen/v1",
		// OpenCode manages its own login (`opencode auth login`), so prefer the
		// subscription path — Agentplate stores no key and the `opencode` runtime
		// uses its existing Zen login, mirroring Anthropic→claude.
		supportsSubscription: true,
		subscriptionRuntime: "opencode",
		subscriptionLabel: "OpenCode Zen login (opencode auth)",
		docsUrl: "https://opencode.ai/docs/zen",
		// OpenCode Zen models, addressed in the `opencode` runtime's `provider/model`
		// form (`opencode/<name>`); a bare id is "Invalid model format". The free
		// (`*-free`) catalog ROTATES often, so this is a current snapshot, not a
		// contract — the wizard always allows a custom id. Verified against
		// `opencode models` (opencode 1.15.x).
		models: [
			{ id: "opencode/minimax-m3-free", label: "MiniMax M3 (free)", contextWindow: 200_000 },
			{ id: "opencode/big-pickle", label: "Big Pickle", contextWindow: 200_000 },
			{
				id: "opencode/deepseek-v4-flash-free",
				label: "DeepSeek V4 Flash (free)",
				contextWindow: 200_000,
			},
			{ id: "opencode/mimo-v2.5-free", label: "MiMo V2.5 (free)", contextWindow: 200_000 },
			{
				id: "opencode/nemotron-3-super-free",
				label: "Nemotron 3 Super (free)",
				contextWindow: 204_800,
			},
		],
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		description: "DeepSeek chat and reasoner models",
		kind: "gateway",
		authEnvVar: "DEEPSEEK_API_KEY",
		defaultBaseUrl: "https://api.deepseek.com/v1",
		docsUrl: "https://platform.deepseek.com/api_keys",
		models: [
			{ id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 128_000 },
			{ id: "deepseek-reasoner", label: "DeepSeek Reasoner", contextWindow: 128_000 },
		],
	},
	{
		id: "google",
		label: "Google Gemini",
		description: "Latest Gemini 3.x models (1M context)",
		kind: "gateway",
		authEnvVar: "GEMINI_API_KEY",
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		supportsSubscription: true,
		subscriptionRuntime: "gemini",
		subscriptionLabel: "Google account (Gemini CLI login)",
		docsUrl: "https://aistudio.google.com/apikey",
		// Latest Gemini lineup verified against models.dev (release dates). 3.1 Pro
		// leads (frontier coding/reasoning); 3.5 Flash is the newest fast model;
		// `gemini-flash-latest` is Google's always-newest Flash alias. 2.5 Pro is the
		// current non-preview GA fallback. The wizard always allows a custom id.
		models: [
			{ id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", contextWindow: 1_048_576 },
			{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", contextWindow: 1_048_576 },
			{ id: "gemini-3-pro-preview", label: "Gemini 3 Pro (preview)", contextWindow: 1_048_576 },
			{
				id: "gemini-3.1-flash-lite",
				label: "Gemini 3.1 Flash Lite (low-cost)",
				contextWindow: 1_048_576,
			},
			{ id: "gemini-flash-latest", label: "Gemini Flash (latest alias)", contextWindow: 1_048_576 },
			{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (GA)", contextWindow: 1_048_576 },
		],
	},
	{
		id: "ollama",
		label: "Ollama (local)",
		description: "Run open models locally — no API key required",
		kind: "gateway",
		authEnvVar: "OLLAMA_API_KEY",
		// Root URL, no /v1 — Ollama serves Anthropic-compat /v1/messages and
		// OpenAI-compat /v1/chat/completions from the root; runtimes append paths.
		defaultBaseUrl: "http://localhost:11434",
		keyless: true,
		docsUrl: "https://ollama.com/library",
		// Tool-calling-capable coding models only — agents need function calling.
		models: [
			{ id: "qwen3-coder:30b", label: "Qwen3 Coder 30B (tool-capable)", contextWindow: 262_144 },
			{ id: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B", contextWindow: 128_000 },
			{ id: "llama3.3:70b", label: "Llama 3.3 70B", contextWindow: 128_000 },
		],
	},
	{
		id: "custom",
		label: "Custom endpoint",
		description: "Any OpenAI-compatible endpoint (self-hosted, NIM, vLLM, …)",
		kind: "gateway",
		authEnvVar: "AGENTPLATE_CUSTOM_API_KEY",
		requiresBaseUrl: true,
		docsUrl: undefined,
		models: [],
	},
];

/** Look up a provider spec by id. */
export function getProviderSpec(id: string): ProviderSpec | undefined {
	return PROVIDERS.find((p) => p.id === id);
}

/** All provider specs, in catalog order. */
export function listProviders(): readonly ProviderSpec[] {
	return PROVIDERS;
}

/** Does this model satisfy the minimum context requirement? */
export function meetsContextFloor(model: ProviderModel): boolean {
	return model.contextWindow >= MIN_CONTEXT_TOKENS;
}
