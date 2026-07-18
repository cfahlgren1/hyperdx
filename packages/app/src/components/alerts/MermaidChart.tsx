import * as React from 'react';
import { useMantineColorScheme } from '@mantine/core';

let renderCounter = 0;

/**
 * Renders a mermaid diagram from agent-produced markdown. Falls back to the
 * raw source in a code block if the diagram fails to parse.
 */
export function MermaidChart({ chart }: { chart: string }) {
  const [svg, setSvg] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const { colorScheme } = useMantineColorScheme();

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        const dark = colorScheme === 'dark';
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: 'inherit',
          themeVariables: dark
            ? {
                background: 'transparent',
                primaryColor: '#25262b',
                primaryBorderColor: '#373a40',
                primaryTextColor: '#c1c2c5',
                lineColor: '#5c5f66',
                fontSize: '12px',
              }
            : {
                background: 'transparent',
                primaryColor: '#f8f9fa',
                primaryBorderColor: '#dee2e6',
                primaryTextColor: '#343a40',
                lineColor: '#adb5bd',
                fontSize: '12px',
              },
        });
        // Presentation belongs to the app: drop any model-authored classDefs
        // and inject theme-aware verdict styles for the class names the
        // prompt asks for (confirmed / ruledout).
        const themed =
          chart.replace(/^\s*classDef .*$/gm, '').trimEnd() +
          (dark
            ? '\nclassDef confirmed fill:#2ea04322,stroke:#2ea043,color:#7ee2a8' +
              '\nclassDef ruledout fill:#f8514915,stroke:#a94442,color:#e0a8a8'
            : '\nclassDef confirmed fill:#2ea04315,stroke:#2ea043,color:#1a7f37' +
              '\nclassDef ruledout fill:#f851490f,stroke:#d1242f,color:#a40e26');
        const { svg: rendered } = await mermaid.render(
          `investigation-mermaid-${renderCounter++}`,
          themed,
        );
        if (!cancelled) {
          setSvg(rendered);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, colorScheme]);

  if (failed) {
    return (
      <pre style={{ fontSize: 11, overflowX: 'auto' }}>
        <code>{chart}</code>
      </pre>
    );
  }
  if (!svg) {
    return null;
  }
  return (
    <div
      style={{ overflowX: 'auto', margin: '8px 0' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
