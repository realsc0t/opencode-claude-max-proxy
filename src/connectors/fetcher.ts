/**
 * Model fetcher — discovers available models from API endpoints.
 *
 * Supports OpenAI-compatible /v1/models and Anthropic's model listing.
 */

import type { ConnectorConfig, ModelEntry } from "./types"

/**
 * Fetch available models from an OpenAI-compatible API.
 * Calls GET /v1/models with the provided API key.
 */
async function fetchOpenAIModels(baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
  }
  const data = await response.json() as { data?: Array<{ id: string; context_window?: number }> }
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("Invalid response: missing data array")
  }
  return data.data
    .filter((m: any) => m.id && typeof m.id === "string")
    .map((m: any) => ({
      id: m.id,
      name: m.id,
      enabled: false,
      contextWindow: m.context_window || undefined,
      lastSeen: Date.now(),
    }))
    .sort((a: ModelEntry, b: ModelEntry) => a.id.localeCompare(b.id))
}

/**
 * Fetch available models from the Anthropic API.
 * Calls GET /v1/models with the provided API key.
 */
async function fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`
  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
  }
  const data = await response.json() as { data?: Array<{ id: string; display_name?: string }> }
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("Invalid response: missing data array")
  }
  return data.data
    .filter((m: any) => m.id && typeof m.id === "string")
    .map((m: any) => ({
      id: m.id,
      name: m.display_name || m.id,
      enabled: false,
      lastSeen: Date.now(),
    }))
    .sort((a: ModelEntry, b: ModelEntry) => a.id.localeCompare(b.id))
}

/**
 * Fetch models for a connector based on its type.
 * Preserves existing enabled state for models that were previously configured.
 */
export async function fetchModelsForConnector(
  connector: ConnectorConfig
): Promise<ModelEntry[]> {
  if (connector.type === "claude-sdk") {
    throw new Error("Claude SDK models are predefined, not fetched")
  }

  if (!connector.baseUrl || !connector.apiKey) {
    throw new Error("Connector requires baseUrl and apiKey to fetch models")
  }

  let freshModels: ModelEntry[]
  if (connector.type === "openai") {
    freshModels = await fetchOpenAIModels(connector.baseUrl, connector.apiKey)
  } else {
    freshModels = await fetchAnthropicModels(connector.baseUrl, connector.apiKey)
  }

  // Preserve enabled state from existing models
  const existingById = new Map(connector.models.map(m => [m.id, m]))
  return freshModels.map(m => ({
    ...m,
    enabled: existingById.get(m.id)?.enabled ?? false,
  }))
}
