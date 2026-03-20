/**
 * Extract SDK AgentDefinition objects from OpenCode's Task tool description.
 *
 * OpenCode (via oh-my-opencode or other frameworks) sends a Task tool with
 * descriptions of each available agent. We parse these and convert them into
 * Claude Agent SDK `AgentDefinition` objects so the SDK's native Task handler
 * routes to properly-configured subagents.
 *
 * This means whatever agents the user configures in their framework
 * automatically become available as SDK subagents — with descriptions,
 * model tiers, and tool access.
 */

/** SDK-compatible agent definition */
export interface AgentDefinition {
  description: string
  prompt: string
  model?: "sonnet" | "opus" | "haiku" | "inherit"
  tools?: string[]
  disallowedTools?: string[]
}

/**
 * Parse agent entries from the Task tool description text.
 *
 * Expected format (from OpenCode):
 *   - agent-name: Description of what the agent does
 *
 * @returns Map of agent name → description
 */
export function parseAgentDescriptions(taskDescription: string): Map<string, string> {
  const agents = new Map<string, string>()

  const agentSection = taskDescription.match(
    /Available agent types.*?:\n((?:- [\w][\w-]*:.*\n?)+)/s
  )
  if (!agentSection) return agents

  const entries = agentSection[1]!.matchAll(/^- ([\w][\w-]*):\s*(.+)/gm)
  for (const match of entries) {
    agents.set(match[1]!, match[2]!.trim())
  }

  return agents
}

/**
 * Map an OpenCode model string to an SDK model tier.
 *
 * The SDK only accepts 'sonnet' | 'opus' | 'haiku' | 'inherit'.
 * We map based on the model name pattern, defaulting to 'inherit'
 * for non-Anthropic models (they'll use the parent session's model).
 */
export function mapModelTier(model?: string): "sonnet" | "opus" | "haiku" | "inherit" {
  if (!model) return "inherit"
  const lower = model.toLowerCase()
  if (lower.includes("opus")) return "opus"
  if (lower.includes("haiku")) return "haiku"
  if (lower.includes("sonnet")) return "sonnet"
  return "inherit"
}

/**
 * Build SDK AgentDefinition objects from the Task tool description.
 *
 * Each agent gets:
 * - description: from the Task tool text (user-configured)
 * - prompt: instructional prompt incorporating the description
 * - model: 'inherit' (uses parent session model — all requests go through our proxy)
 * - tools: undefined (inherit all tools from parent)
 *
 * @param taskDescription - The full Task tool description text from OpenCode
 * @param mcpToolNames - Optional list of MCP tool names to make available to agents
 */
export function buildAgentDefinitions(
  taskDescription: string,
  mcpToolNames?: string[]
): Record<string, AgentDefinition> {
  const descriptions = parseAgentDescriptions(taskDescription)
  const agents: Record<string, AgentDefinition> = {}

  for (const [name, description] of descriptions) {
    agents[name] = {
      description,
      prompt: buildAgentPrompt(name, description),
      model: "inherit",
      // Give agents access to MCP tools if provided
      ...(mcpToolNames?.length ? { tools: [...mcpToolNames] } : {}),
    }
  }

  return agents
}

/**
 * Build a system prompt for an agent based on its name and description.
 */
function buildAgentPrompt(name: string, description: string): string {
  return `You are the "${name}" agent. ${description}

Focus on your specific role and complete the task thoroughly. Return a clear, concise result.`
}
