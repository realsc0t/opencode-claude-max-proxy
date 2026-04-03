/**
 * Connector configuration types.
 *
 * A connector represents a backend AI provider that the proxy can route
 * requests to. Each connector has connection details and a list of
 * available/selected models.
 */

export type ConnectorType = "claude-sdk" | "openai" | "anthropic"

export interface ModelEntry {
  /** Model ID as returned by the API (e.g., "gpt-4o", "claude-sonnet-4-20250514") */
  id: string
  /** Human-readable display name */
  name: string
  /** Whether this model is enabled for proxy clients */
  enabled: boolean
  /** Context window size (if known) */
  contextWindow?: number
  /** When this model was last seen in the API listing */
  lastSeen?: number
}

export interface ConnectorConfig {
  /** Unique connector ID */
  id: string
  /** Connector type */
  type: ConnectorType
  /** Human-readable name */
  name: string
  /** Whether this connector is active */
  enabled: boolean
  /** API base URL (for openai/anthropic types) */
  baseUrl?: string
  /** API key (for openai/anthropic types) — stored encrypted at rest */
  apiKey?: string
  /** Available models (discovered via API or hardcoded for claude-sdk) */
  models: ModelEntry[]
  /** Max concurrent requests for this connector */
  maxConcurrent: number
  /** When this connector was created */
  createdAt: number
  /** When models were last fetched */
  modelsLastFetched?: number
}

/** Default Claude SDK models */
export const CLAUDE_SDK_MODELS: ModelEntry[] = [
  { id: "sonnet", name: "Sonnet (200k)", enabled: true, contextWindow: 200_000 },
  { id: "sonnet[1m]", name: "Sonnet (1M)", enabled: true, contextWindow: 1_000_000 },
  { id: "opus", name: "Opus (200k)", enabled: false, contextWindow: 200_000 },
  { id: "opus[1m]", name: "Opus (1M)", enabled: false, contextWindow: 1_000_000 },
  { id: "haiku", name: "Haiku", enabled: false, contextWindow: 200_000 },
]
