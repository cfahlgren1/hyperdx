import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim() ?? '';
// Default "owner/repo" for searches and issue creation.
const GITHUB_REPO = process.env.GITHUB_REPO?.trim() ?? '';

const MAX_RESULTS = 10;
const MAX_BODY_CHARS = 2000;
const MAX_FILE_CHARS = 30_000;

interface GithubIssue {
  number: number;
  state: string;
  title: string;
  html_url: string;
  updated_at: string;
  body?: string | null;
  labels?: { name?: string }[];
}

interface GithubCodeResult {
  path: string;
  html_url: string;
}

interface GithubContent {
  type: string;
  path: string;
  content?: string;
}

interface GithubComment {
  user?: { login?: string };
  created_at: string;
  body?: string | null;
}

async function github(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${GITHUB_TOKEN}`,
      'user-agent': 'clickstack-agent',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  return {
    ok: response.ok,
    status: response.status,
    json: await response.json().catch(() => undefined),
  };
}

const repoInput = v.optional(v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/)));

function resolveRepo(repo: string | undefined): string | undefined {
  return repo ?? (GITHUB_REPO || undefined);
}

const searchIssues = defineTool({
  name: 'github_search_issues',
  description:
    'Search GitHub issues and pull requests. Useful for correlating an incident with known issues, recent regressions, or open work. Returns compact results with issue numbers and URLs.',
  input: v.object({
    query: v.pipe(v.string(), v.minLength(2), v.maxLength(200)),
    repo: repoInput,
  }),
  run: async ({ input }) => {
    const repo = resolveRepo(input.repo);
    const q = repo ? `${input.query} repo:${repo}` : input.query;
    const result = await github(
      `/search/issues?per_page=${MAX_RESULTS}&q=${encodeURIComponent(q)}`,
    );
    if (!result.ok) {
      return `GitHub search failed (${result.status}).`;
    }
    const items =
      (result.json as { items?: GithubIssue[] } | undefined)?.items ?? [];
    if (items.length === 0) {
      return 'No matching issues or pull requests.';
    }
    return items
      .map(
        item =>
          `#${item.number} [${item.state}] ${item.title}\n${item.html_url}\nupdated ${item.updated_at}${item.labels?.length ? ` labels: ${item.labels.map(l => l.name).join(', ')}` : ''}`,
      )
      .join('\n\n');
  },
});

const getIssue = defineTool({
  name: 'github_get_issue',
  description:
    'Read a GitHub issue or pull request: title, state, body, and the latest comments.',
  input: v.object({
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    repo: repoInput,
  }),
  run: async ({ input }) => {
    const repo = resolveRepo(input.repo);
    if (!repo) {
      return 'No repository given and GITHUB_REPO is not configured.';
    }
    const issue = await github(`/repos/${repo}/issues/${input.number}`);
    if (!issue.ok) {
      return `GitHub read failed (${issue.status}).`;
    }
    const comments = await github(
      `/repos/${repo}/issues/${input.number}/comments?per_page=5&sort=created&direction=desc`,
    );
    const item = issue.json as GithubIssue;
    const commentText = ((comments.json as GithubComment[] | undefined) ?? [])
      .map(
        c =>
          `--- ${c.user?.login} (${c.created_at}):\n${(c.body ?? '').slice(0, MAX_BODY_CHARS)}`,
      )
      .join('\n');
    return `#${item.number} [${item.state}] ${item.title}\n${item.html_url}\n\n${(item.body ?? '').slice(0, MAX_BODY_CHARS)}\n\n${commentText}`;
  },
});

const searchCode = defineTool({
  name: 'github_search_code',
  description:
    'Search source code on GitHub. Useful for finding where an implicated service, config value, error message, or query lives in the codebase. Returns matching file paths with URLs.',
  input: v.object({
    query: v.pipe(v.string(), v.minLength(2), v.maxLength(200)),
    repo: repoInput,
  }),
  run: async ({ input }) => {
    const repo = resolveRepo(input.repo);
    if (!repo) {
      return 'No repository given and GITHUB_REPO is not configured.';
    }
    const q = `${input.query} repo:${repo}`;
    const result = await github(
      `/search/code?per_page=${MAX_RESULTS}&q=${encodeURIComponent(q)}`,
    );
    if (!result.ok) {
      return `GitHub code search failed (${result.status}).`;
    }
    const items =
      (result.json as { items?: GithubCodeResult[] } | undefined)?.items ?? [];
    if (items.length === 0) {
      return 'No matching code.';
    }
    return items.map(item => `${item.path}\n${item.html_url}`).join('\n\n');
  },
});

const readFile = defineTool({
  name: 'github_read_file',
  description:
    'Read a file (or list a directory) from a GitHub repository. Paths are repo-relative; omit path or pass "" for the repository root.',
  input: v.object({
    path: v.optional(v.pipe(v.string(), v.maxLength(500)), ''),
    repo: repoInput,
    ref: v.optional(v.pipe(v.string(), v.maxLength(100))),
  }),
  run: async ({ input }) => {
    const repo = resolveRepo(input.repo);
    if (!repo) {
      return 'No repository given and GITHUB_REPO is not configured.';
    }
    const ref = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : '';
    const result = await github(
      `/repos/${repo}/contents/${input.path.replace(/^\/+/, '')}${ref}`,
    );
    if (!result.ok) {
      return `GitHub read failed (${result.status}).`;
    }
    if (Array.isArray(result.json)) {
      return (result.json as GithubContent[])
        .map(entry => `${entry.type === 'dir' ? 'dir ' : 'file'} ${entry.path}`)
        .join('\n');
    }
    const file = result.json as GithubContent;
    if (file.type !== 'file' || typeof file.content !== 'string') {
      return `Not a readable file (type: ${file.type}).`;
    }
    const text = Buffer.from(file.content, 'base64').toString('utf8');
    return text.length > MAX_FILE_CHARS
      ? `${text.slice(0, MAX_FILE_CHARS)}\n... truncated (${text.length} chars total)`
      : text;
  },
});

const createIssue = defineTool({
  name: 'github_create_issue',
  description:
    'Create a GitHub issue. Only use this when the user explicitly asks you to file an issue. Include your evidence and remediation suggestions in the body, and tell the user the issue URL.',
  input: v.object({
    title: v.pipe(v.string(), v.minLength(4), v.maxLength(200)),
    body: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
    labels: v.optional(v.array(v.pipe(v.string(), v.maxLength(50)))),
    repo: repoInput,
  }),
  run: async ({ input }) => {
    const repo = resolveRepo(input.repo);
    if (!repo) {
      return 'No repository given and GITHUB_REPO is not configured.';
    }
    const result = await github(`/repos/${repo}/issues`, {
      method: 'POST',
      body: { title: input.title, body: input.body, labels: input.labels },
    });
    if (!result.ok) {
      return `GitHub issue creation failed (${result.status}).`;
    }
    return `Created ${(result.json as GithubIssue).html_url}`;
  },
});

/** Read-only GitHub tools for every session; empty when GITHUB_TOKEN is unset. */
export const githubTools = GITHUB_TOKEN
  ? [searchIssues, getIssue, searchCode, readFile]
  : [];

/**
 * Issue creation is conversation-only: automated alert investigations stay
 * read-only, a human in the loop has to ask for an issue.
 */
export const githubWriteTools = GITHUB_TOKEN ? [createIssue] : [];
