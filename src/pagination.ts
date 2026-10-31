/**
 * Pagination helpers — async generators over paged endpoints.
 *
 * Two common shapes are covered:
 * - `paginate.pages(...)`: classic page numbers (`?page=1,2,3...`)
 * - `paginate.cursor(...)`: cursor / offset tokens returned by the API
 */

export interface PageOptions<R> {
  /** First page number. Default `1`. */
  start?: number;
  /** Safety cap on the number of pages fetched. Default `1000`. */
  maxPages?: number;
  /**
   * Decides whether to keep going. Defaults to "stop when the page is an
   * empty array (or nullish)".
   */
  until?: (result: R, page: number) => boolean;
}

function defaultUntil<R>(result: R): boolean {
  if (Array.isArray(result)) return result.length > 0;
  return result !== null && result !== undefined;
}

/**
 * Iterates page-based endpoints.
 *
 * ```ts
 * for await (const page of paginate.pages((page) => github.listUsers({ page }))) {
 *   users.push(...page);
 * }
 * ```
 */
export function pages<R>(
  fetchPage: (page: number) => Promise<R>,
  options: PageOptions<R> = {},
): AsyncGenerator<R, void, void> {
  const start = options.start ?? 1;
  const maxPages = options.maxPages ?? 1000;
  const until = options.until ?? defaultUntil;

  return (async function* (): AsyncGenerator<R, void, void> {
    for (let page = start; page < start + maxPages; page++) {
      const result = await fetchPage(page);
      if (!until(result, page)) return;
      yield result;
    }
  })();
}

export interface CursorOptions {
  /** Safety cap on the number of fetches. Default `1000`. */
  maxPages?: number;
}

export interface CursorPage<T, C> {
  /** Elements of this page. */
  data: readonly T[];
  /** Cursor for the next page; absent / null / undefined means "done". */
  nextCursor?: C | null;
}

/**
 * Iterates cursor-based endpoints, yielding individual items.
 *
 * ```ts
 * for await (const item of paginate.cursor((cursor) =>
 *   stripe.listCustomers({ starting_after: cursor }),
 * )) { ... }
 * ```
 */
export function cursor<T, C>(
  fetchPage: (cursor: C | undefined) => Promise<CursorPage<T, C>>,
  options: CursorOptions = {},
): AsyncGenerator<T, void, void> {
  const maxPages = options.maxPages ?? 1000;

  return (async function* (): AsyncGenerator<T, void, void> {
    let next: C | undefined = undefined;
    let fetched = 0;
    do {
      if (fetched >= maxPages) return;
      const page = await fetchPage(next);
      fetched += 1;
      for (const item of page.data) yield item;
      next = page.nextCursor ?? undefined;
    } while (next !== undefined);
  })();
}

/** Drains an async generator into an array. */
export async function collect<T>(gen: AsyncGenerator<T, void, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/** Namespace bundling the pagination helpers. */
export const paginate = { pages, cursor, collect };
