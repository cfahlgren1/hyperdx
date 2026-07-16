import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AnyZodObject } from 'zod';

type McpUserPrincipal = { kind: 'user'; id: string };
type McpAgentPrincipal = { kind: 'agent'; id: string };

/**
 * The authenticated caller of an MCP request. Discriminated so that an agent
 * principal with full (write) access is unrepresentable: write tools require a
 * real user for ownership, and agents are read-only by construction.
 */
export type McpContext =
  | { teamId: string; access: 'full'; principal: McpUserPrincipal }
  | { teamId: string; access: 'read'; principal: McpAgentPrincipal };

/** Context narrowed to user callers, required by write tools. */
type McpUserContext = Extract<McpContext, { access: 'full' }>;

/**
 * The result shape every MCP tool handler should return.
 *
 * Intersects the SDK's `CallToolResult` (which carries an index signature
 * from the `$loose` Zod modifier) with a narrower `content` array so tool
 * handlers are constrained to text-only content blocks.
 */
export type ToolResult = CallToolResult & {
  content: { type: 'text'; text: string }[];
};

/**
 * A simplified tool registration function that wraps `server.registerTool`
 * with automatic tracing. Eliminates the need to:
 * - Pass the tool name twice (once to registerTool, once to withToolTracing)
 * - Import and manually wire up withToolTracing in every tool file
 * - Import McpServer type in every tool file
 */
export type RegisterToolFn = <TSchema extends AnyZodObject>(
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: TSchema;
  },
  handler: (args: TSchema['_output']) => Promise<ToolResult>,
) => void;

export type ToolRegistrar = {
  server: McpServer;
  context: McpContext;
  registerTool: RegisterToolFn;
};

export type ToolDefinition = (registrar: ToolRegistrar) => void;

/**
 * Registrar for write tools. Carries the user-narrowed context so tools that
 * mutate team data (and need a real user for ownership) cannot be registered
 * for a read-only agent principal — the mismatch fails at compile time.
 */
export type WriteToolRegistrar = Omit<ToolRegistrar, 'context'> & {
  context: McpUserContext;
};

export type WriteToolDefinition = (registrar: WriteToolRegistrar) => void;

export type PromptDefinition = (server: McpServer, context: McpContext) => void;
