import type { ReactNode } from "react";

type Side = "old" | "new";
type Row = { text: string; side: Side | null; line: number | null; oldLine: number | null; newLine: number | null; kind: string };

/** Render the patch itself, so comments can sit directly below their anchored line. */
export function InlineReviewDiff({ patch, renderLine, onAdd }: { patch: string; renderLine: (side: Side, line: number) => ReactNode; onAdd: (side: Side, line: number) => void }) {
  let oldLine = 0; let newLine = 0;
  const rows: Row[] = patch.split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, side: null, line: null, oldLine: null, newLine: null, kind: "hunk" }; }
    if (!oldLine && !newLine || text.startsWith("\\")) return { text, side: null, line: null, oldLine: null, newLine: null, kind: "meta" };
    if (text.startsWith("+")) { const line = newLine++; return { text, side: "new", line, oldLine: null, newLine: line, kind: "add" }; }
    if (text.startsWith("-")) { const line = oldLine++; return { text, side: "old", line, oldLine: line, newLine: null, kind: "remove" }; }
    if (text.startsWith(" ")) { const before = oldLine++; const after = newLine++; return { text, side: "new", line: after, oldLine: before, newLine: after, kind: "context" }; }
    return { text, side: null, line: null, oldLine: null, newLine: null, kind: "meta" };
  });
  return <div className="gs-inline-diff" aria-label="Inline comment diff">{rows.map((row, index) => row.side && row.line !== null ? <div key={index}>
    <div className={`gs-inline-row gs-inline-${row.kind}`}>
      <button type="button" className="gs-inline-add-button" aria-label={`Add comment on ${row.side} line ${row.line}`} onClick={() => onAdd(row.side!, row.line!)}>＋</button>
      <span className="gs-inline-number">{row.oldLine ?? ""}</span><span className="gs-inline-number">{row.newLine ?? ""}</span><code>{row.text}</code>
    </div>{row.kind === "context" && row.oldLine !== null ? renderLine("old", row.oldLine) : null}{renderLine(row.side, row.line)}
  </div> : row.text ? <div key={index} className={`gs-inline-meta gs-inline-${row.kind}`}>{row.text}</div> : null)}</div>;
}
