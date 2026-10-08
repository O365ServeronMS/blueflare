# Pagination Algorithm (Netflix-style compact window)

The pagination logic in this project (`components/Pagination.tsx`) follows a strict Netflix-style compact window algorithm.
**DO NOT** modify this algorithm to use endless scrolling, simple 10-page windows, or basic prev/next buttons.

## Required display rule
- Always show: First page, Last page, Current page, 2 pages before, 2 pages after.
- Ellipsis `...` between non-contiguous page ranges.
- If the gap between two adjacent pages is exactly 2, insert the missing page instead of ellipsis.
- Never show duplicate pages.
- Never show invalid pages (< 1 or > totalPages).
- The current page must be visibly active.
- Ellipsis must be non-clickable.
- The pagination state must preserve all existing query parameters, updating only the `page` parameter without resetting search keywords, filters, or source navigation state.
- Keep pagination logic encapsulated in the React `Pagination.tsx` component utility.

## Examples
- `currentPage = 15, totalPages = 777` -> `1 ... 13 14 15 16 17 ... 777`
- `currentPage = 3, totalPages = 777` -> `1 2 3 4 5 ... 777`
- `currentPage = 776, totalPages = 777` -> `1 ... 774 775 776 777`
- `currentPage = 5, totalPages = 777` -> `1 2 3 4 5 6 7 ... 777` (Gap of 2 inserts page 2 instead of ellipsis)

If modifying `components/Pagination.tsx`, you must run validation against these examples to ensure the strict Netflix-style compact window is preserved.
