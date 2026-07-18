import * as React from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { AlertInvestigationItem } from '@hyperdx/common-utils/dist/types';
import { ActionIcon, Badge, Box, Drawer, Group, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
} from '@tabler/icons-react';

import api from '@/api';
import { FormatTime } from '@/useFormatTime';

import { StepList } from './InvestigationTrajectory';
import { MermaidChart } from './MermaidChart';

const SEVERITY_COLORS: Record<string, string> = {
  P1: 'red',
  P2: 'orange',
  P3: 'yellow',
};

export function SeverityChip({ severity }: { severity?: string }) {
  if (!severity) return null;
  return (
    <Badge
      variant="light"
      color={SEVERITY_COLORS[severity] ?? 'gray'}
      size="sm"
      radius="sm"
      style={{ flexShrink: 0 }}
    >
      {severity}
    </Badge>
  );
}

const OUTCOMES: Record<string, { label: string; color: string }> = {
  root_cause: { label: '✓ Root cause', color: 'green' },
  linked: { label: '✓ Linked', color: 'teal' },
  benign: { label: '· Benign', color: 'gray' },
  inconclusive: { label: '? Inconclusive', color: 'yellow' },
};

export function OutcomeBadge({ outcome }: { outcome?: string }) {
  const config = outcome ? OUTCOMES[outcome] : undefined;
  if (!config) return null;
  return (
    <Badge
      variant="light"
      color={config.color}
      size="sm"
      radius="sm"
      tt="none"
      style={{ flexShrink: 0 }}
    >
      {config.label}
    </Badge>
  );
}

function getAlertUrl(item: AlertInvestigationItem): string {
  if (item.dashboardId) {
    return `/dashboards/${item.dashboardId}?highlightedTileId=${item.tileId}`;
  }
  if (item.savedSearchId) {
    return `/search/${item.savedSearchId}`;
  }
  return '/alerts';
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function investigationDuration(item: AlertInvestigationItem): string | null {
  if (!item.investigation.completedAt) return null;
  const ms =
    new Date(item.investigation.completedAt).getTime() -
    new Date(item.investigation.requestedAt).getTime();
  if (ms <= 0) return null;
  return ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.round(ms / 60_000)}m`;
}

const reportMarkdown = {
  // The drawer header already names the alert; drop the report's own h1.
  h1: () => null,
  h2: ({ children }: { children?: React.ReactNode }) => (
    <Text
      size="sm"
      fw={700}
      mt={18}
      mb={5}
      style={{
        borderTop: '1px solid var(--mantine-color-default-border)',
        paddingTop: 12,
      }}
    >
      {children}
    </Text>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <Text size="sm" fw={700} mt={12} mb={3}>
      {children}
    </Text>
  ),
  code: ({
    className,
    children,
  }: {
    className?: string;
    children?: React.ReactNode;
  }) => {
    if (className?.includes('language-mermaid')) {
      return <MermaidChart chart={String(children).trim()} />;
    }
    return (
      <code
        className={className}
        style={{
          background:
            'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-8))',
          border: '1px solid var(--mantine-color-default-border)',
          borderRadius: 4,
          padding: '1px 5px',
          fontSize: 11.5,
        }}
      >
        {children}
      </code>
    );
  },
  // Let block code render without the default <pre> chrome so mermaid blocks
  // control their own layout.
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

export function InvestigationDrawer({
  item,
  onClose,
}: {
  item: AlertInvestigationItem | null;
  onClose: () => void;
}) {
  const [expanded, { toggle: toggleExpanded }] = useDisclosure(false);
  const trajectory = api.useInvestigationTrajectory(
    item?.investigation.hasTrajectory ? item.alertHistoryId : null,
  );
  const steps = trajectory.data?.data;
  const usage = trajectory.data?.usage;
  const duration = item ? investigationDuration(item) : null;

  return (
    <Drawer
      opened={item != null}
      onClose={onClose}
      position="right"
      size={expanded ? '100%' : 640}
      padding="md"
      styles={{ title: { flex: 1 } }}
      title={
        item && (
          <Group gap="xs" wrap="nowrap" justify="space-between" w="100%">
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              <SeverityChip severity={item.investigation.severity} />
              <Text size="sm" fw={600} truncate>
                {item.alertName}
              </Text>
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                <FormatTime value={new Date(item.createdAt)} />
              </Text>
            </Group>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={toggleExpanded}
              title={expanded ? 'Shrink panel' : 'Expand panel'}
            >
              {expanded ? (
                <IconArrowsDiagonalMinimize2 size={14} />
              ) : (
                <IconArrowsDiagonal size={14} />
              )}
            </ActionIcon>
          </Group>
        )
      }
    >
      {item && (
        <Box>
          <Text size="md" fw={600} lineClamp={3} style={{ lineHeight: 1.5 }}>
            {item.investigation.gist}
          </Text>
          <Group gap={10} mt={8} align="center">
            {item.investigation.confidence != null && (
              <Text size="xs" fw={700} style={{ flexShrink: 0 }}>
                {Math.round(item.investigation.confidence)}%{' '}
                <Text span size="xs" c="dimmed" fw={400}>
                  confident
                </Text>
              </Text>
            )}
            <OutcomeBadge outcome={item.investigation.outcome} />
          </Group>

          {item.investigation.hasTrajectory && (
            <Box mt="md">
              {steps ? (
                <StepList steps={steps} />
              ) : trajectory.isError ? (
                <Text size="xs" c="dimmed">
                  Trajectory is no longer available for this investigation.
                </Text>
              ) : (
                <Text size="xs" c="dimmed">
                  Loading steps…
                </Text>
              )}
            </Box>
          )}

          <Box mt="md">
            <Text
              size="10px"
              fw={700}
              tt="uppercase"
              c="dimmed"
              mb={4}
              style={{ letterSpacing: '0.08em' }}
            >
              Full report
            </Text>
            <Box
              style={{ fontSize: 13, lineHeight: 1.7 }}
              className="hdx-markdown"
            >
              <ReactMarkdown components={reportMarkdown}>
                {item.investigation.summary}
              </ReactMarkdown>
            </Box>
          </Box>

          <Group
            justify="space-between"
            mt="md"
            py="sm"
            px="md"
            mx="calc(var(--mantine-spacing-md) * -1)"
            mb="calc(var(--mantine-spacing-md) * -1)"
            style={{
              position: 'sticky',
              bottom: 0,
              background: 'var(--mantine-color-body)',
              borderTop: '1px solid var(--mantine-color-default-border)',
            }}
          >
            <Text size="11px" c="dimmed" ff="monospace">
              {[
                usage ? `↑ ${formatTokens(usage.inputTokens)} in` : undefined,
                usage?.cachedTokens
                  ? `${formatTokens(usage.cachedTokens)} cached`
                  : undefined,
                usage ? `↓ ${formatTokens(usage.outputTokens)} out` : undefined,
                usage ? `$${usage.costUsd.toFixed(2)}` : undefined,
                duration,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <Link
              href={getAlertUrl(item)}
              className="text-decoration-none fs-8"
            >
              View source data →
            </Link>
          </Group>
        </Box>
      )}
    </Drawer>
  );
}
