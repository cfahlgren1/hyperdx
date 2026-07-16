import { setTraceAttributes } from '@hyperdx/node-opentelemetry';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { validateMcpCredential } from '@/middleware/auth';
import logger from '@/utils/logger';
import rateLimiter, { rateLimiterKeyGenerator } from '@/utils/rateLimiter';

import { createServer } from './mcpServer';

// host '0.0.0.0' disables the SDK's DNS-rebinding Host-header check, which
// would otherwise reject in-network callers (e.g. the on-call agent reaching
// `http://app:8000/mcp` inside Compose). The check protects unauthenticated
// localhost servers from browser-based rebinding; every request here must
// carry a Bearer credential, which a rebinding attacker cannot obtain or
// automatically attach.
const app = createMcpExpressApp({ host: '0.0.0.0' });

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
