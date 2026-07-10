---
"@hyperdx/app": patch
---

Copy `css.d.ts` into the Docker builder stage alongside `mdx.d.ts`. The TypeScript 6 upgrade added `packages/app/css.d.ts` to type side-effect stylesheet imports (e.g. `@mantine/core/styles.css`), but the Dockerfile only copied `mdx.d.ts`, so the production/all-in-one image build failed type checking with TS2882. This is required for the all-in-one image the MCP eval CI pipeline builds.
