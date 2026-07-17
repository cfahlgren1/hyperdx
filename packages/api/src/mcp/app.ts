import { setTraceAttributes } from '@hyperdx/node-opentelemetry';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { validateMcpCredential } from '@/middleware/auth';
import logger from '@/utils/logger';
import rateLimiter, { rateLimiterKeyGenerator } from '@/utils/rateLimiter';

import { createServer } from './mcpServer';

// The SDK's DNS-rebinding protection rejects any Host that isn't localhost,
// which breaks in-network callers like the agent reaching `app:8000` inside
// Compose. Keep the protection but allowlist the hosts a deployment actually
// serves (extendable via the comma-separated MCP_ALLOWED_HOSTS env).
const buildAllowedHosts = (urls: (string | undefined)[]): string[] => {
  const hosts = ['localhost', '127.0.0.1', '[::1]', 'app'];
  for (const extra of (process.env.MCP_ALLOWED_HOSTS ?? '').split(',')) {
    if (extra.trim()) hosts.push(extra.trim());
  }
  for (const url of urls) {
    if (!url) continue;
    try {
      hosts.push(new URL(url).hostname);
    } catch {
      // ignore a malformed URL — it just won't be allowlisted
    }
  }
  return hosts;
};

const app = createMcpExpressApp({
  allowedHosts: buildAllowedHosts([process.env.FRONTEND_URL]),
});

const mcpRateLimiter = rateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 600, // 10 req/s
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimiterKeyGenerator,
});

app.all('/', mcpRateLimiter, validateMcpCredential, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  const context = req.mcpContext;
  if (!context) {
    logger.warn('MCP request rejected: no authenticated context');
    res.sendStatus(401);
    return;
  }

  setTraceAttributes({
    'mcp.team.id': context.teamId,
    'mcp.principal.kind': context.principal.kind,
    'mcp.principal.id': context.principal.id,
    ...(context.principal.kind === 'user'
      ? { 'mcp.user.id': context.principal.id }
      : {}),
  });

  logger.info(
    {
      teamId: context.teamId,
      principalKind: context.principal.kind,
      principalId: context.principal.id,
    },
    'MCP request received',
  );

  const server = createServer(context);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    await server.close();
    await transport.close();
  }
});

export default app;
