/**
 * Request router — routes requests to the appropriate connector.
 *
 * Sits in front of the existing Claude SDK handler. For API connectors
 * (OpenAI/Anthropic), forwards the request directly to the upstream API.
 * For the Claude SDK connector, falls through to the existing handler.
 */

import type { ConnectorConfig } from "./types"
import { findConnectorForModel, getConnectorInternal } from "./store"

export interface RouteResult {
  /** How to handle this request */
  action: "claude-sdk" | "forward-openai" | "forward-anthropic" | "reject"
  /** The connector to use (undefined for reject) */
  connector?: ConnectorConfig
  /** Error message if rejected */
  error?: string
}

/**
 * Determine how to route a request based on the model name.
 * Returns the routing action and connector config.
 */
export function routeRequest(model: string): RouteResult {
  // Find which connector handles this model
  const connector = findConnectorForModel(model)

  if (!connector) {
    return {
      action: "reject",
      error: `Model "${model}" is not available. Enable it in the Configuration tab.`,
    }
  }

  if (connector.type === "claude-sdk") {
    return { action: "claude-sdk", connector }
  }

  // Get the full connector (with unmasked API key)
  const fullConnector = getConnectorInternal(connector.id)
  if (!fullConnector?.baseUrl || !fullConnector?.apiKey) {
    return {
      action: "reject",
      error: `Connector "${connector.name}" is missing baseUrl or apiKey.`,
    }
  }

  if (connector.type === "openai") {
    return { action: "forward-openai", connector: fullConnector }
  }

  return { action: "forward-anthropic", connector: fullConnector }
}
