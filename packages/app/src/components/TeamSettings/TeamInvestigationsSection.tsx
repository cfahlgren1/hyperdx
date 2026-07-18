import { useEffect, useState } from 'react';
import { Card, Group, Stack, Switch, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';

import api from '@/api';

export default function TeamInvestigationsSection() {
  const { data: team, refetch: refetchTeam } = api.useTeam();
  const updateSettings = api.useUpdateTeamInvestigationsSettings();

  // Absent means enabled — deployments that predate the setting investigate
  // by default.
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (team) {
      setEnabled(team.investigationsEnabled !== false);
    }
  }, [team]);

  const onToggle = (next: boolean) => {
    setEnabled(next);
    updateSettings.mutate(
      { investigationsEnabled: next },
      {
        onSuccess: () => {
          refetchTeam();
          notifications.show({
            color: 'green',
            message: `AI investigations ${next ? 'enabled' : 'disabled'} for the team`,
          });
        },
        onError: () => {
          setEnabled(!next);
          notifications.show({
            color: 'red',
            message: 'Failed to update AI investigation settings',
          });
        },
      },
    );
  };

  return (
    <Card>
      <Card.Section p="md" py="xs" withBorder>
        <Text>AI Investigations</Text>
      </Card.Section>
      <Card.Section p="md">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2}>
            <Text size="sm">
              Investigate fresh alert fires with the on-call agent
            </Text>
            <Text size="xs" c="dimmed">
              When off, no alert in this team dispatches investigations,
              regardless of per-alert settings. Existing summaries stay visible.
            </Text>
          </Stack>
          <Switch
            checked={enabled}
            onChange={event => onToggle(event.currentTarget.checked)}
            disabled={updateSettings.isPending}
          />
        </Group>
      </Card.Section>
    </Card>
  );
}
