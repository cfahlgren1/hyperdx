import * as React from 'react';
import Link from 'next/link';
import { formatDistanceToNowStrict } from 'date-fns';
import ReactMarkdown from 'react-markdown';
import { AlertInvestigationItem } from '@hyperdx/common-utils/dist/types';
import {
  Badge,
  Box,
  Collapse,
  Group,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChevronDown, IconReportSearch } from '@tabler/icons-react';

import api from '@/api';
import { FormatTime } from '@/useFormatTime';

function getAlertUrl(item: AlertInvestigationItem): string {
  if (item.dashboardId) {
    return `/dashboards/${item.dashboardId}?highlightedTileId=${item.tileId}`;
  }
  if (item.savedSearchId) {
    return `/search/${item.savedSearchId}`;
  }
  return '/alerts';
}

/** First sentence of the "Most Probable Cause" section, for the gist line. */
function extractGist(summary: string): string {
  const causeMatch = summary.match(
    /\*\*Most Probable Cause:?\*\*\s*\n?([\s\S]*?)(?=\n\s*\n|\n#|$)/i,
  );
  const source = causeMatch?.[1] ?? summary;
  const line = source
    .split('\n')
    .map(l =>
      l
        .replace(/^[#*\-\s]+/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
    .find(l => l.length > 20);
  return line ?? summary.slice(0, 160);
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

function InvestigationCard({ item }: { item: AlertInvestigationItem }) {
  const [opened, { toggle }] = useDisclosure(false);
  const duration = investigationDuration(item);
  const firedAt = new Date(item.createdAt);

  return (
    <Paper withBorder p="md" radius="md">
      <UnstyledButton onClick={toggle} w="100%">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={6} style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <IconReportSearch
                size={15}
                style={{
                  color: 'var(--mantine-primary-color-filled)',
                  flexShrink: 0,
                }}
              />
              <Badge variant="light" color="red" size="sm">
                Fired
              </Badge>
              <Text size="sm" fw={600} truncate>
                {item.alertName}
              </Text>
              {item.group && (
                <Badge variant="light" color="gray" size="xs">
                  {item.group}
                </Badge>
              )}
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                <FormatTime value={firedAt} />
              </Text>
            </Group>
            {!opened && (
              <Text size="sm" c="gray.4" lineClamp={2}>
                {extractGist(item.investigation.summary)}
              </Text>
            )}
          </Stack>
          <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
            <Text size="xs" c="dimmed">
              {formatDistanceToNowStrict(firedAt, { addSuffix: true })}
              {duration ? ` · investigated in ${duration}` : ''}
            </Text>
            <IconChevronDown
              size={14}
              style={{
                transform: opened ? 'rotate(180deg)' : 'none',
                transition: 'transform 100ms ease',
                color: 'var(--mantine-color-dimmed)',
              }}
            />
          </Group>
        </Group>
      </UnstyledButton>
      <Collapse expanded={opened}>
        <Box
          mt="sm"
          pl="md"
          style={{
            borderLeft: '2px solid var(--mantine-primary-color-filled)',
            fontSize: 13,
            lineHeight: 1.6,
          }}
          className="hdx-markdown"
        >
          <ReactMarkdown>{item.investigation.summary}</ReactMarkdown>
        </Box>
        <Group justify="flex-end" mt="xs">
          <Link href={getAlertUrl(item)} className="text-decoration-none fs-8">
            View source data →
          </Link>
        </Group>
      </Collapse>
    </Paper>
  );
}

// Chronological feed of AI investigation reports across all alerts, newest
// first. Backed by GET /alerts/investigations, which queries investigations
// directly instead of the rolling per-alert history window, so summaries stay
// reachable after they scroll out of the 20-entry chart history.
export function InvestigationsFeed() {
  const { data, isLoading } = api.useAlertInvestigations();
  const entries = data?.data ?? [];

  if (isLoading) {
    return (
      <Text size="sm" c="dimmed" ta="center" py={40}>
        Loading...
      </Text>
    );
  }

  if (entries.length === 0) {
    return (
      <Stack align="center" py={60} gap="xs">
        <IconReportSearch
          size={32}
          style={{ color: 'var(--mantine-color-dimmed)' }}
        />
        <Text fw={600}>No investigations yet</Text>
        <Text size="sm" c="dimmed" ta="center" maw={420}>
          When an alert fires, the on-call agent investigates the underlying
          telemetry and its findings appear here.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="sm" mt="md">
      {entries.map((item, i) => (
        <InvestigationCard key={i} item={item} />
      ))}
    </Stack>
  );
}
