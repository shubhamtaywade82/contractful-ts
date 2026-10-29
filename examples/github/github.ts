/**
 * Example: a GitHub connector built with contractful-ts.
 *
 * Mirrors the contractful README example (Ruby):
 *
 *   class GitHubAPI
 *     include Contractful::Contract
 *     base 'https://api.github.com'
 *     contract :list_users, 'GET /users' do ... end
 *   end
 *
 * Run it after `npm run build`:
 *   GITHUB_TOKEN=... node examples/github/github.ts
 */

// In your own project, import from the package instead:
//   import { auth, contract, defineApi, P, paginate } from 'contractful-ts';
import { auth, contract, defineApi, P, paginate } from '../../dist/index.js';

export interface GitHubUser {
  login: string;
  id: number;
  /** Open response: any other field GitHub returns is passed through. */
  [field: string]: unknown;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  [field: string]: unknown;
}

export const GitHubApi = defineApi({
  name: 'GitHubApi',
  base: 'https://api.github.com',
  defaultHeaders: { Accept: 'application/vnd.github+json' },
  // Unauthenticated calls work at a lower rate limit; set GITHUB_TOKEN for more.
  auth: process.env.GITHUB_TOKEN
    ? auth.bearer(() => process.env.GITHUB_TOKEN!)
    : undefined,
  retry: { retries: 2, baseDelay: 250, maxDelay: 4_000 },
  contracts: {
    /** GET /users — public, paginated. */
    listUsers: contract<GitHubUser[]>('GET /users', {
      description: 'List GitHub users.',
      params: {
        since: P.integer({ describe: 'Only return users with an ID greater than this.' }),
        perPage: P.integer({
          as: 'per_page',
          min: 1,
          max: 100,
          default: 30,
          describe: 'Results per page (1..100).',
        }),
      },
      responds: [{ status: 200, type: 'array' }],
    }),

    /** GET /users/:username */
    getUser: contract<GitHubUser>('GET /users/:username', {
      params: { username: P.string({ required: true, length: { max: 39 } }) },
      responds: [{ status: 200, type: 'hash' }, { status: 404 }],
    }),

    /** POST /repos/:owner/:repo/issues — idempotency-keyed write. */
    createIssue: contract<GitHubIssue>('POST /repos/:owner/:repo/issues', {
      description: 'Open a new issue.',
      idempotent: true,
      params: {
        owner: P.string({ required: true }),
        repo: P.string({ required: true }),
        title: P.string({ required: true, length: { min: 1, max: 256 } }),
        body: P.string({ in: 'body', describe: 'Issue body (Markdown).' }),
        labels: P.array({ of: P.string(), default: [] }),
      },
      responds: [{ status: 201, type: 'hash' }, { status: 422 }],
    }),
  },
});

async function main(): Promise<void> {
  const github = new GitHubApi();

  console.log(GitHubApi.describe());
  console.log();

  // Closed request schema: typos fail before any HTTP traffic.
  try {
    // @ts-expect-error deliberate typo to demonstrate runtime rejection
    await github.listUsers({ pagee: 1 });
  } catch (err) {
    console.log('rejected bad input:', (err as Error).message);
  }

  const users = await github.listUsers({ perPage: 5 });
  console.log(`fetched ${users.length} users:`, users.map((u) => u.login).join(', '));

  try {
    const octocat = await github.getUser({ username: 'octocat' });
    console.log('octocat profile:', octocat.login, `(id ${octocat.id})`);
  } catch (err) {
    // Unauthenticated GitHub calls are rate-limited to ~60/hour by IP;
    // HttpStatusError carries the parsed body for a friendly note.
    console.log('getUser rate-limited (set GITHUB_TOKEN to avoid):', (err as Error).message);
  }

  // Cursor-based pagination: GitHub's /users pages through `since` (the
  // last seen user id) — the closed schema keeps us honest about it.
  try {
    const firstTwoPages = await paginate.collect(
      paginate.cursor(
        async (since) => {
          const batch = await github.listUsers({
            perPage: 10,
            ...(since !== undefined ? { since } : {}),
          });
          return {
            data: batch,
            nextCursor: batch.length > 0 ? batch[batch.length - 1]!.id : undefined,
          };
        },
        { maxPages: 2 },
      ),
    );
    console.log(`pagination collected ${firstTwoPages.length} users over up to 2 pages`);
  } catch {
    console.log('pagination skipped (rate limited without a token)');
  }
}

main().catch((err) => {
  // Anonymous GitHub calls are heavily rate-limited per IP (~60/hour).
  // When the quota is spent the demo exits with a friendly note instead
  // of a stack trace — error classes make this classification trivial.
  const status = (err as { status?: number }).status;
  if (status === 403 || status === 429) {
    console.log('\nGitHub rate limit reached for this IP — set GITHUB_TOKEN to run the full demo.');
    process.exit(0);
  }
  console.error('github example failed:', err);
  process.exit(1);
});
