import { describe, expect, it } from 'vitest';
import { collect, cursor, pages, paginate } from '../src/pagination.js';

describe('paginate.pages', () => {
  it('iterates until an empty page', async () => {
    const pagesFetched: number[] = [];
    const gen = pages(async (page) => {
      pagesFetched.push(page);
      return page < 3 ? [`item-${page}`] : [];
    });
    const drained = await collect(gen);
    expect(drained).toEqual([['item-1'], ['item-2']]);
    expect(pagesFetched).toEqual([1, 2, 3]);
  });

  it('supports custom start pages', async () => {
    const seen: number[] = [];
    await collect(
      pages(async (page) => {
        seen.push(page);
        return page < 5 ? [page] : [];
      }, { start: 4 }),
    );
    expect(seen).toEqual([4, 5]);
  });

  it('honors a custom until predicate', async () => {
    const seen: number[] = [];
    await collect(
      pages(
        async (page) => {
          seen.push(page);
          return { total: 100, page, items: ['a'] };
        },
        { until: (r) => r.page < 2, maxPages: 10 },
      ),
    );
    expect(seen).toEqual([1, 2]);
  });

  it('respects the maxPages safety cap', async () => {
    let fetched = 0;
    await collect(
      pages(
        async () => {
          fetched++;
          return ['always-full'];
        },
        { maxPages: 4 },
      ),
    );
    expect(fetched).toBe(4);
  });
});

describe('paginate.cursor', () => {
  it('yields items until the cursor runs dry', async () => {
    const calls: (string | undefined)[] = [];
    const gen = cursor<string, string>(async (cursorArg) => {
      calls.push(cursorArg);
      if (cursorArg === undefined) {
        return { data: ['a', 'b'], nextCursor: 'page-2' };
      }
      if (cursorArg === 'page-2') {
        return { data: ['c'], nextCursor: null };
      }
      return { data: [], nextCursor: null };
    });
    const items = await collect(gen);
    expect(items).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual([undefined, 'page-2']);
  });

  it('handles empty first pages', async () => {
    const items = await collect(
      cursor(async () => ({ data: [] as number[], nextCursor: undefined })),
    );
    expect(items).toEqual([]);
  });

  it('respects maxPages', async () => {
    let fetched = 0;
    const items = await collect(
      cursor<number, number>(
        async (c) => {
          fetched++;
          return { data: [c ?? 0], nextCursor: (c ?? 0) + 1 };
        },
        { maxPages: 3 },
      ),
    );
    expect(items).toEqual([0, 1, 2]);
    expect(fetched).toBe(3);
  });
});

describe('paginate namespace', () => {
  it('exposes pages, cursor and collect', () => {
    expect(paginate.pages).toBe(pages);
    expect(paginate.cursor).toBe(cursor);
    expect(paginate.collect).toBe(collect);
  });
});
