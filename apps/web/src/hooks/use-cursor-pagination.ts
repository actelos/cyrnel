import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { apiFetchJson, errorMessageFrom } from "@/lib/api";

interface PaginatedPage<T> {
  items: T[];
  nextCursor: string | null;
}

interface UseCursorPaginationOptions<TPage extends PaginatedPage<unknown>> {
  url: string;
  schema: z.ZodType<TPage>;
  getCursorParam?: (cursor: string) => Record<string, string | undefined>;
}

export function useCursorPagination<TItem, TPage extends PaginatedPage<TItem>>({
  url,
  schema,
  getCursorParam,
}: UseCursorPaginationOptions<TPage>) {
  const [extraItems, setExtraItems] = useState<TItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const versionRef = useRef(0);

  // Reset pagination state whenever the base URL changes.
  useEffect(() => {
    versionRef.current += 1;
    setExtraItems([]);
    setNextCursor(null);
    setLoadMoreError(null);
    // Reference url so the reset is tied to its identity.
    void url;
  }, [url]);

  const syncFirstPage = useCallback(
    (firstPage: TPage | undefined, isValidating: boolean) => {
      if (extraItems.length === 0 && firstPage !== undefined && !isValidating) {
        setNextCursor(firstPage.nextCursor);
      }
    },
    [extraItems.length],
  );

  const loadMore = useCallback(async () => {
    if (nextCursor === null || isLoadingMore) return;
    const startedVersion = versionRef.current;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const cursorParams = getCursorParam
        ? getCursorParam(nextCursor)
        : { cursor: nextCursor };
      const separator = url.includes("?") ? "&" : "?";
      const params = new URLSearchParams(
        Object.entries(cursorParams).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const data = await apiFetchJson(
        `${url}${separator}${params.toString()}`,
        schema,
      );
      if (versionRef.current !== startedVersion) return;
      setExtraItems((previous) => [...previous, ...data.items] as TItem[]);
      setNextCursor(data.nextCursor);
    } catch (error) {
      if (versionRef.current !== startedVersion) return;
      setLoadMoreError(errorMessageFrom(error, "Failed to load more items."));
    } finally {
      if (versionRef.current === startedVersion) {
        setIsLoadingMore(false);
      }
    }
  }, [nextCursor, isLoadingMore, url, schema, getCursorParam]);

  const reset = useCallback(() => {
    versionRef.current += 1;
    setExtraItems([]);
    setNextCursor(null);
    setLoadMoreError(null);
  }, []);

  const merged = useMemo(
    () => ({ extraItems, nextCursor, isLoadingMore, loadMoreError }),
    [extraItems, nextCursor, isLoadingMore, loadMoreError],
  );

  return { ...merged, loadMore, reset, syncFirstPage, versionRef };
}
