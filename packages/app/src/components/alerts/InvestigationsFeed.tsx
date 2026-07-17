import * as React from 'react';
import Link from 'next/link';
import {
  format,
  formatDistanceToNowStrict,
  isToday,
  isYesterday,
} from 'date-fns';
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

function dayLabel(date: Date): string {
  if (isToday(date)) return `Today — ${format(date, 'MMM d')}`;
  if (isYesterday(date)) return `Yesterday — ${format(date, 'MMM d')}`;
  return format(date, 'EEEE — MMM d, yyyy');
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
    <Paper withBorder p="sm" px="md" radius="md">
      <UnstyledButton onClick={toggle} w="100%">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={5} style={{ minWidth: 0 }}>
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
                {item.investigation.gist}
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

function TimelineItem({ item }: { item: AlertInvestigationItem }) {
  return (
    <Box pos="relative" mb={10}>
      {/* Centered on the rail: container pl=26 and rail center at 7.5px put
          the 9px dot at -23; top 18 centers it on the card's first row. */}
      <Box
        pos="absolute"
        left={-23}
        top={18}
        w={9}
        h={9}
        style={{
          borderRadius: '50%',
          background: 'var(--mantine-color-red-6)',
          boxShadow:
            '0 0 0 3px var(--mantine-color-body), 0 0 8px var(--mantine-color-red-9)',
        }}
      />
      <InvestigationCard item={item} />
    </Box>
  );
}

// Chronological timeline of AI investigation reports across all alerts,
// newest first and grouped by day. Backed by GET /alerts/investigations,
// which queries investigations directly instead of the rolling per-alert
// history window, so summaries stay reachable after they scroll out of the
// 20-entry chart history.
export function InvestigationsFeed({
  entries,
  isLoading,
  isError,
}: {
  entries: AlertInvestigationItem[];
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <Text size="sm" c="dimmed" ta="center" py={40}>
        Loading...
      </Text>
    );
  }

  if (isError) {
    return (
      <Text size="sm" c="red.4" ta="center" py={40}>
        Failed to load investigations. Refresh to try again.
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

  // Entries arrive newest-first; group consecutive runs by calendar day.
  const groups: { label: string; items: AlertInvestigationItem[] }[] = [];
  for (const item of entries) {
    const label = dayLabel(new Date(item.createdAt));
    const last = groups[groups.length - 1];
    if (last?.label === label) {
      last.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }

  return (
    <Box pos="relative" pl={26} mt="md">
      <Box
        pos="absolute"
        left={7}
        top={6}
        bottom={6}
        w={1}
        bg="var(--mantine-color-default-border)"
      />
      {groups.map(group => (
        <Box key={group.label}>
          <Text size="xs" c="dimmed" tt="uppercase" lts={1} mt="lg" mb={10}>
            {group.label}
          </Text>
          {group.items.map((item, i) => (
            <TimelineItem key={i} item={item} />
          ))}
        </Box>
      ))}
    </Box>
  );
}
