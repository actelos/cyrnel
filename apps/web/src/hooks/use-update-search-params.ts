import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * Returns a stable updater that patches the current URL search params.
 *
 * - Always uses `replace: true` so typing in a filter or toggling a tab
 *   doesn't spam browser history (the URL stays shareable/bookmarkable,
 *   but back goes to the previous page, not the previous keystroke).
 * - `undefined`, `null`, or `""` values delete the key, which keeps default
 *   values out of the URL (e.g. `/services` instead of
 *   `/services?tab=installed&enabled=all`).
 * - All other params are preserved untouched.
 */
export function useUpdateSearchParams(): (
  patch: Record<string, string | undefined | null>,
) => void {
  const [, setSearchParams] = useSearchParams();

  return useCallback(
    (patch: Record<string, string | undefined | null>) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === null || value === "") {
              next.delete(key);
            } else {
              next.set(key, value);
            }
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
}
