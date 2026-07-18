import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTrash } from '@tabler/icons-react';

import api from '@/api';

/**
 * Team-authored context injected into the agent's investigation prompt (an
 * agents.md). Editable only here — the agent has no write path to it.
 */
function AgentInstructionsCard() {
  const { data: team, refetch: refetchTeam } = api.useTeam();
  const updateInstructions = api.useUpdateAgentInstructions();
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (team && !loaded) {
      setDraft(team.agentInstructions ?? '');
      setLoaded(true);
    }
  }, [team, loaded]);

  const onSave = () => {
    updateInstructions.mutate(
      { agentInstructions: draft },
      {
        onSuccess: () => {
          refetchTeam();
          notifications.show({ color: 'green', message: 'Instructions saved' });
        },
        onError: () =>
          notifications.show({
            color: 'red',
            message: 'Failed to save instructions',
          }),
      },
    );
  };

  return (
    <Card>
      <Card.Section p="md" py="xs" withBorder>
        <Text>Agent Instructions</Text>
      </Card.Section>
      <Card.Section p="md">
        <Stack gap="xs">
          <Text size="xs" c="gray.4">
            Environment context injected into every investigation — deploy
            schedules, known-flaky services, conventions. The agent reads this
            but can never edit it.
          </Text>
          <Textarea
            value={draft}
            onChange={e => setDraft(e.currentTarget.value)}
            placeholder={
              'e.g. We deploy Fridays at 16:00 UTC. Staging cluster alerts are usually noise. Payments issues: check the gateway service first.'
            }
            autosize
            minRows={4}
            maxRows={16}
            maxLength={8192}
          />
          <Group justify="flex-end">
            <Button
              variant="primary"
              size="xs"
              onClick={onSave}
              loading={updateInstructions.isPending}
              disabled={!loaded || draft === (team?.agentInstructions ?? '')}
            >
              Save Instructions
            </Button>
          </Group>
        </Stack>
      </Card.Section>
    </Card>
  );
}

/** The agent's durable memories: what it has learned, correctable by humans. */
function AgentMemoriesCard() {
  const { data, refetch } = api.useAgentMemories();
  const saveMemory = api.useSaveAgentMemory();
  const deleteMemory = api.useDeleteAgentMemory();
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [newSlug, setNewSlug] = useState('');

  const memories = data?.data ?? [];
  const isCreating =
    editingSlug != null && !memories.some(m => m.slug === editingSlug);

  const onSave = (slug: string, content: string) => {
    saveMemory.mutate(
      { slug, content },
      {
        onSuccess: () => {
          setEditingSlug(null);
          setNewSlug('');
          refetch();
          notifications.show({
            color: 'green',
            message: `Memory "${slug}" saved`,
          });
        },
        onError: () =>
          notifications.show({
            color: 'red',
            message: 'Failed to save memory (kebab-case slug, max 4KB)',
          }),
      },
    );
  };

  const onDelete = (slug: string) => {
    deleteMemory.mutate(
      { slug },
      {
        onSuccess: () => {
          refetch();
          notifications.show({
            color: 'green',
            message: `Memory "${slug}" deleted`,
          });
        },
      },
    );
  };

  return (
    <Card>
      <Card.Section p="md" py="xs" withBorder>
        <Text>Agent Memory</Text>
      </Card.Section>
      <Card.Section p="md">
        <Stack gap="sm">
          <Text size="xs" c="gray.4">
            Durable notes the agent keeps between investigations. It writes
            these itself after runs; correct or delete anything wrong here.
          </Text>
          {memories.length === 0 && (
            <Text size="sm" c="dimmed">
              No memories yet — the agent saves durable environment facts as it
              investigates.
            </Text>
          )}
          {memories.length > 0 && (
            <Table>
              <Table.Tbody>
                {memories.map(memory => (
                  <Table.Tr key={memory.slug}>
                    <Table.Td w={220} valign="top">
                      <Text size="sm" ff="monospace">
                        {memory.slug}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {editingSlug === memory.slug ? (
                        <Textarea
                          value={editContent}
                          onChange={e => setEditContent(e.currentTarget.value)}
                          autosize
                          minRows={2}
                          maxLength={4096}
                        />
                      ) : (
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                          {memory.content}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td w={140} valign="top">
                      <Group gap="xs" justify="flex-end">
                        {editingSlug === memory.slug ? (
                          <>
                            <Button
                              size="compact-xs"
                              variant="primary"
                              loading={saveMemory.isPending}
                              onClick={() => onSave(memory.slug, editContent)}
                            >
                              Save
                            </Button>
                            <Button
                              size="compact-xs"
                              variant="secondary"
                              onClick={() => setEditingSlug(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="compact-xs"
                              variant="secondary"
                              onClick={() => {
                                setEditingSlug(memory.slug);
                                setEditContent(memory.content);
                              }}
                            >
                              Edit
                            </Button>
                            <ActionIcon
                              variant="danger"
                              size="sm"
                              title={`Delete memory ${memory.slug}`}
                              onClick={() => onDelete(memory.slug)}
                            >
                              <IconTrash size={14} />
                            </ActionIcon>
                          </>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          <Group gap="xs">
            <TextInput
              size="xs"
              placeholder="new-memory-slug"
              value={newSlug}
              onChange={e => setNewSlug(e.currentTarget.value.toLowerCase())}
              w={220}
            />
            <Button
              size="compact-xs"
              variant="secondary"
              disabled={!/^[a-z0-9][a-z0-9-]{0,59}$/.test(newSlug)}
              onClick={() => {
                setEditingSlug(newSlug);
                setEditContent('');
              }}
            >
              Add Memory
            </Button>
          </Group>
          {isCreating && (
            <Stack gap="xs">
              <Text size="sm" ff="monospace">
                {editingSlug}
              </Text>
              <Textarea
                value={editContent}
                onChange={e => setEditContent(e.currentTarget.value)}
                autosize
                minRows={2}
                maxLength={4096}
                placeholder="What should the agent remember?"
              />
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="primary"
                  loading={saveMemory.isPending}
                  disabled={editContent.trim().length === 0}
                  onClick={() => onSave(editingSlug!, editContent)}
                >
                  Save
                </Button>
                <Button
                  size="compact-xs"
                  variant="secondary"
                  onClick={() => setEditingSlug(null)}
                >
                  Cancel
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Card.Section>
    </Card>
  );
}

export default function TeamAgentSection() {
  return (
    <Stack gap="md">
      <AgentInstructionsCard />
      <AgentMemoriesCard />
    </Stack>
  );
}
