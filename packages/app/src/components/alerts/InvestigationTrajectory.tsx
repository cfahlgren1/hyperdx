import * as React from 'react';
import { InvestigationTrajectoryStep } from '@hyperdx/common-utils/dist/types';
import { Box, Group, Text, UnstyledButton } from '@mantine/core';
import { IconBrain, IconChevronDown } from '@tabler/icons-react';

const VISIBLE_STEPS = 3;

function formatDuration(ms?: number): string | null {
  if (ms == null || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function ThinkingRow({ step }: { step: InvestigationTrajectoryStep }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Box
      py={7}
      style={{
        borderBottom:
          '1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-6))',
      }}
    >
      <UnstyledButton onClick={() => setOpen(o => !o)} w="100%">
        <Group gap={10} wrap="nowrap" align={open ? 'flex-start' : 'center'}>
          <Box
            style={{
              width: 18,
              flexShrink: 0,
              display: 'flex',
              justifyContent: 'flex-start',
            }}
          >
            <IconBrain
              size={13}
              style={{ color: 'var(--mantine-color-dimmed)', opacity: 0.7 }}
            />
          </Box>
          <Text
            size="xs"
            c="dimmed"
            fs="italic"
            truncate={!open}
            style={
              open
                ? { whiteSpace: 'pre-wrap', lineHeight: 1.5, opacity: 0.8 }
                : { flex: 1, minWidth: 0, opacity: 0.8 }
            }
          >
            {step.text}
          </Text>
        </Group>
      </UnstyledButton>
    </Box>
  );
}

function StepRow({
  step,
  index,
}: {
  step: InvestigationTrajectoryStep;
  index: number;
}) {
  const [open, setOpen] = React.useState(false);
  const duration = formatDuration(step.durationMs);
  const preview =
    step.input ?? (step.result ?? '').split('\n').find(l => l.trim()) ?? '';

  return (
    <Box
      py={7}
      style={{
        borderBottom:
          '1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-6))',
      }}
    >
      <UnstyledButton onClick={() => setOpen(o => !o)} w="100%">
        <Group gap={10} wrap="nowrap" align="baseline">
          <Text
            size="11px"
            ff="monospace"
            c={step.isError ? 'red.5' : 'dimmed'}
            style={{ flexShrink: 0, width: 18, opacity: 0.6 }}
          >
            {String(index + 1).padStart(2, '0')}
          </Text>
          <Text
            size="xs"
            ff="monospace"
            fw={600}
            c={step.isError ? 'red.4' : undefined}
            style={{ flexShrink: 0 }}
          >
            {step.toolName}
          </Text>
          <Text
            size="xs"
            c="dimmed"
            truncate
            style={{ flex: 1, minWidth: 0, opacity: 0.65 }}
          >
            {preview}
          </Text>
          {duration && (
            <Text
              size="11px"
              c="dimmed"
              ff="monospace"
              style={{ flexShrink: 0, opacity: 0.55 }}
            >
              {duration}
            </Text>
          )}
        </Group>
        {open && (step.input || step.result) && (
          <Box
            mt={6}
            ml={28}
            p="xs"
            style={{
              background:
                'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))',
              border: '1px solid var(--mantine-color-default-border)',
              borderRadius: 6,
              maxHeight: 300,
              overflowY: 'auto',
            }}
          >
            {step.input && (
              <>
                <Text size="9px" fw={700} tt="uppercase" c="dimmed" mb={2}>
                  Input
                </Text>
                <Text
                  size="11px"
                  c="dimmed"
                  ff="monospace"
                  mb={step.result ? 8 : 0}
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {step.input}
                </Text>
              </>
            )}
            {step.result && (
              <>
                <Text size="9px" fw={700} tt="uppercase" c="dimmed" mb={2}>
                  Result
                </Text>
                <Text
                  size="11px"
                  c="dimmed"
                  ff="monospace"
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {step.result}
                </Text>
              </>
            )}
          </Box>
        )}
      </UnstyledButton>
    </Box>
  );
}

/**
 * Moodboard-style numbered step list of the investigation's tool calls: the
 * first few visible, the rest behind "show all"; click a row for the full
 * result.
 */
export function StepList({ steps }: { steps: InvestigationTrajectoryStep[] }) {
  const [showAll, setShowAll] = React.useState(false);
  const toolCount = steps.filter(step => step.type === 'tool').length;
  // Position of each step among the tool calls, computed without render-time
  // mutation (step lists are capped small).
  const toolNumber = steps.map(
    (_, i) => steps.slice(0, i + 1).filter(s => s.type === 'tool').length,
  );
  // Collapsed view ends after the first few tool calls, keeping any thinking
  // rows that precede them.
  const cutoffIndex = steps.findIndex(
    (_, i) => toolNumber[i] === VISIBLE_STEPS,
  );
  const collapsed = !showAll && cutoffIndex !== -1 && toolCount > VISIBLE_STEPS;
  const visible = collapsed ? steps.slice(0, cutoffIndex + 1) : steps;
  const hidden = toolCount - (collapsed ? VISIBLE_STEPS : toolCount);

  const list = (
    <Box>
      <Box
        style={
          collapsed
            ? {
                WebkitMaskImage:
                  'linear-gradient(to bottom, black 72%, transparent 100%)',
                maskImage:
                  'linear-gradient(to bottom, black 72%, transparent 100%)',
              }
            : undefined
        }
      >
        {visible.map((step, i) =>
          step.type === 'thinking' ? (
            <ThinkingRow key={i} step={step} />
          ) : (
            <StepRow key={i} step={step} index={toolNumber[i] - 1} />
          ),
        )}
      </Box>
      {toolCount > VISIBLE_STEPS && (
        <Group justify="center" mt={collapsed ? -4 : 0}>
          <UnstyledButton onClick={() => setShowAll(v => !v)} py={2}>
            <Group gap={5} wrap="nowrap">
              <IconChevronDown
                size={13}
                style={{
                  transform: showAll ? 'rotate(180deg)' : 'none',
                  transition: 'transform 120ms ease',
                  color: 'var(--mantine-color-dimmed)',
                }}
              />
              {!showAll && (
                <Text size="xs" c="dimmed">
                  {hidden} more
                </Text>
              )}
            </Group>
          </UnstyledButton>
        </Group>
      )}
    </Box>
  );

  return (
    <Box
      px="sm"
      pt={8}
      pb={4}
      style={{
        background:
          'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))',
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 8,
      }}
    >
      <Text
        size="10px"
        fw={700}
        tt="uppercase"
        c="dimmed"
        mb={2}
        style={{ letterSpacing: '0.12em' }}
      >
        Steps · {toolCount} calls
      </Text>
      {list}
    </Box>
  );
}
