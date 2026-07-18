import * as React from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { AlertInvestigationItem } from '@hyperdx/common-utils/dist/types';
import { Box, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconReportSearch } from '@tabler/icons-react';

import { FormatTime } from '@/useFormatTime';

import {
  InvestigationDrawer,
  OutcomeBadge,
  SeverityChip,
} from './InvestigationDrawer';

function dayLabel(date: Date): string {
  if (isToday(date)) return `Today — ${format(date, 'MMM d')}`;
  if (isYesterday(date)) return `Yesterday — ${format(date, 'MMM d')}`;
  return format(date, 'EEEE — MMM d, yyyy');
}

function InvestigationRow({
  item,
  onOpen,
}: {
  item: AlertInvestigationItem;
  onOpen: () => void;
}) {
  return (
    <Paper withBorder radius="md" mb={8}>
      <UnstyledButton onClick={onOpen} w="100%" p="sm" px="md">
        <Group gap="sm" wrap="nowrap">
          <SeverityChip severity={item.investigation.severity} />
          <Text size="sm" fw={600} style={{ flexShrink: 0 }} truncate>
            {item.alertName}
          </Text>
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            <FormatTime value={new Date(item.createdAt)} />
          </Text>
          <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
            {item.investigation.gist}
          </Text>
          <OutcomeBadge outcome={item.investigation.outcome} />
        </Group>
      </UnstyledButton>
    </Paper>
  );
}

// Verdict-first list of AI investigations across all alerts, newest first and
// grouped by day; a row opens the full investigation in a side drawer. Backed
// by GET /alerts/investigations, which queries investigations directly instead
// of the rolling per-alert history window, so summaries stay reachable after
// they scroll out of the 20-entry chart history.
export function InvestigationsFeed({
  entries,
  isLoading,
  isError,
}: {
  entries: AlertInvestigationItem[];
  isLoading: boolean;
  isError: boolean;
}) {
  const [selected, setSelected] = React.useState<AlertInvestigationItem | null>(
    null,
  );

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

  const counts = {
    root_cause: entries.filter(i => i.investigation.outcome === 'root_cause')
      .length,
    benign: entries.filter(i => i.investigation.outcome === 'benign').length,
    inconclusive: entries.filter(
      i => i.investigation.outcome === 'inconclusive',
    ).length,
  };

  return (
    <Box mt="md">
      {groups.map(group => (
        <Box key={group.label}>
          <Text size="xs" c="dimmed" tt="uppercase" lts={1} mt="lg" mb={10}>
            {group.label}
          </Text>
          {group.items.map((item, i) => (
            <InvestigationRow
              key={i}
              item={item}
              onOpen={() => setSelected(item)}
            />
          ))}
        </Box>
      ))}
      <Group justify="center" mt="lg">
        <Text size="11px" c="dimmed" ff="monospace">
          {[
            `${entries.length} investigations`,
            counts.root_cause ? `${counts.root_cause} root-caused` : undefined,
            counts.benign ? `${counts.benign} benign` : undefined,
            counts.inconclusive
              ? `${counts.inconclusive} inconclusive`
              : undefined,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Group>
      <InvestigationDrawer item={selected} onClose={() => setSelected(null)} />
    </Box>
  );
}
