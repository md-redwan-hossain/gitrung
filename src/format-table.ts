import Table from "cli-table3";

const BOX_CHARS = {
  top: "═",
  "top-mid": "╤",
  "top-left": "╔",
  "top-right": "╗",
  bottom: "═",
  "bottom-mid": "╧",
  "bottom-left": "╚",
  "bottom-right": "╝",
  left: "║",
  "left-mid": "╟",
  mid: "─",
  "mid-mid": "┼",
  right: "║",
  "right-mid": "╢",
  middle: "│",
} as const;

/** Mid chars empty so data rows have no horizontal separators between them. */
const BOX_CHARS_NO_ROW_SEP = {
  ...BOX_CHARS,
  "left-mid": "",
  mid: "",
  "mid-mid": "",
  "right-mid": "",
} as const;

const TABLE_STYLE = {
  head: [] as string[],
  border: [] as string[],
  "padding-left": 1,
  "padding-right": 1,
};

function indentTable(rendered: string): string {
  return rendered
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** Two-column key/value table (same look as step param blocks). */
export function formatKeyValueTable(
  rows: { key: string; value: string }[],
): string {
  if (rows.length === 0) return "";
  return formatCliTable(
    rows.map((r) => [r.key, r.value]),
    { rowSeparators: false },
  );
}

/**
 * Generic bordered table. With `head`, draws a separator under the header;
 * without head and `rowSeparators: false`, matches legacy step param tables.
 */
export function formatCliTable(
  rows: string[][],
  opts?: { head?: string[]; rowSeparators?: boolean },
): string {
  if (rows.length === 0 && !opts?.head) return "";
  const withHead = Boolean(opts?.head);
  const rowSeparators = opts?.rowSeparators ?? withHead;
  const table = new Table({
    chars: rowSeparators ? BOX_CHARS : BOX_CHARS_NO_ROW_SEP,
    style: TABLE_STYLE,
    ...(opts?.head ? { head: opts.head } : {}),
  });
  for (const row of rows) {
    table.push(row);
  }
  return indentTable(table.toString());
}
