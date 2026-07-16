// Mock OpenTelemetry and all modules that transitively import it
// These must be declared before any imports

const mockSpan = {
  setAttribute: jest.fn(),
  setAttributes: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};

const mockTracer = {
  startActiveSpan: (
    _name: string,
    _optionsOrFn: unknown,
    maybeFn?: (span: typeof mockSpan) => Promise<unknown>,
  ) => {
    const fn = (
      typeof _optionsOrFn === 'function' ? _optionsOrFn : maybeFn
    ) as (span: typeof mockSpan) => Promise<unknown>;
    return fn(mockSpan);
  },
};

const mockCounter = { add: jest.fn() };
const mockHistogram = { record: jest.fn() };
const mockMeter = {
  createCounter: jest.fn(() => mockCounter),
  createHistogram: jest.fn(() => mockHistogram),
};

jest.mock('@opentelemetry/api', () => ({
  __esModule: true,
  default: {
    trace: {
      getTracer: () => mockTracer,
      getActiveSpan: () => mockSpan,
    },
    metrics: {
      getMeter: () => mockMeter,
    },
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
  SpanKind: {
    INTERNAL: 0,
    SERVER: 1,
    CLIENT: 2,
    PRODUCER: 3,
    CONSUMER: 4,
  },
}));

jest.mock('@hyperdx/node-opentelemetry', () => ({
  __esModule: true,
  setTraceAttributes: jest.fn(),
}));

jest.mock('@/config', () => ({
  CODE_VERSION: 'test-version',
}));

jest.mock('@/utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { getMcpClickhouseSettings } from '@/mcp/tools/query/helpers';
import type { McpContext } from '@/mcp/tools/types';

const context: McpContext = {
  teamId: 'team-1',
  access: 'read',
  principal: { kind: 'agent', id: 'agent-1' },
};

describe('getMcpClickhouseSettings', () => {
  it('stamps every query with an attribution log_comment', () => {
    const settings = getMcpClickhouseSettings(context);

    expect(settings.readonly).toBe(2);
    expect(settings.max_execution_time).toBe(30);
    expect(JSON.parse(settings.log_comment as string)).toEqual({
      source: 'clickstack-mcp',
      team: 'team-1',
      principal: 'agent',
      principal_id: 'agent-1',
    });
  });
});
