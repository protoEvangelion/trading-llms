import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { ChatCompletionTool } from "openai/resources"
import { join, resolve } from "path"

export interface McpConfig {
  name: string
  command: string
  args: string[]
  config?: Record<string, unknown>
  env?: Record<string, string>
}

export interface McpClients {
  clients: Map<string, { client: Client; tools: string[] }>
  toolDefinitions: ChatCompletionTool[]
}

const ROOT = join(import.meta.dir, "../..")

/** Resolve any relative path args to absolute paths from project root */
function resolveArgs(args: string[]): string[] {
  return args.map((arg) => {
    // If it looks like a file path (no flags, has a slash or .ts/.js extension)
    if (!arg.startsWith("-") && (arg.includes("/") || arg.endsWith(".ts") || arg.endsWith(".js"))) {
      return resolve(ROOT, arg)
    }
    return arg
  })
}

export async function bootMcpClients(mcpConfigs: McpConfig[]): Promise<McpClients> {
  const clients = new Map<string, { client: Client; tools: string[] }>()
  const toolDefinitions: ChatCompletionTool[] = []

  for (const mcpConfig of mcpConfigs) {
    try {
      const transport = new StdioClientTransport({
        command: mcpConfig.command,
        args: resolveArgs(mcpConfig.args),
        env: {
          ...process.env as Record<string, string>,
          ...(mcpConfig.env ?? {}),
        },
        cwd: ROOT,
      })

      const client = new Client(
        { name: `trading-bots-${mcpConfig.name}`, version: "1.0.0" },
        { capabilities: {} }
      )

      await client.connect(transport)

      const { tools } = await client.listTools()
      const toolNames = tools.map((t) => t.name)

      clients.set(mcpConfig.name, { client, tools: toolNames })

      // Convert MCP tool definitions to OpenAI-compatible format
      for (const tool of tools) {
        toolDefinitions.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.inputSchema as Record<string, unknown>,
          },
        })
      }

      console.log(`[mcp] ${mcpConfig.name} connected — tools: ${toolNames.join(", ")}`)
    } catch (err) {
      console.error(`[mcp] Failed to connect ${mcpConfig.name}:`, err)
    }
  }

  return { clients, toolDefinitions }
}

export async function dispatchToolCall(
  mcpClients: McpClients,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  for (const [, { client, tools }] of mcpClients.clients) {
    if (tools.includes(toolName)) {
      // MCP SDK requires arguments to be a non-null record
      const result = await client.callTool({ name: toolName, arguments: args ?? {} })

      const content = result.content as Array<{ type: string; text?: string }>
      const textContent = content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")

      return textContent
    }
  }

  throw new Error(`No MCP server found for tool: ${toolName}`)
}

export async function shutdownMcpClients(mcpClients: McpClients) {
  for (const [name, { client }] of mcpClients.clients) {
    try {
      await client.close()
      console.log(`[mcp] ${name} disconnected`)
    } catch {
      // ignore errors on shutdown
    }
  }
}
