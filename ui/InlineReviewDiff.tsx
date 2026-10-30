import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import ts from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import js from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import type { HighlighterCore, ThemedToken } from "shiki/types";

type Side = "old" | "new";
type Row = { text: string; side: Side | null; line: number | null; oldLine: number | null; newLine: number | null; kind: string; tokenIndex?: number };

function parsePatch(patch: string): Row[] {
  let oldLine = 0; let newLine = 0; let tokenIndex = 0;
  return patch.split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, side: null, line: null, oldLine: null, newLine: null, kind: "hunk" }; }
    if (!oldLine && !newLine || text.startsWith("\\")) return { text, side: null, line: null, oldLine: null, newLine: null, kind: "meta" };
    if (text.startsWith("+")) { const line = newLine++; return { text, side: "new", line, oldLine: null, newLine: line, kind: "add", tokenIndex: tokenIndex++ }; }
    if (text.startsWith("-")) { const line = oldLine++; return { text, side: "old", line, oldLine: line, newLine: null, kind: "remove", tokenIndex: tokenIndex++ }; }
    if (text.startsWith(" ")) { const before = oldLine++; const after = newLine++; return { text, side: "new", line: after, oldLine: before, newLine: after, kind: "context", tokenIndex: tokenIndex++ }; }
    return { text, side: null, line: null, oldLine: null, newLine: null, kind: "meta" };
  });
}

function language(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "ts" || ext === "mts" || ext === "cts") return "typescript";
  if (ext === "tsx" || ext === "jsx") return "tsx";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "javascript";
  if (ext === "json" || ext === "jsonc") return "json";
  if (ext === "py") return "python";
  return null;
}

const highlighters = new WeakMap<PluginCodeThemeData, Promise<HighlighterCore>>();
function highlighterFor(theme: PluginCodeThemeData): Promise<HighlighterCore> {
  const cached = highlighters.get(theme);
  if (cached) return cached;
  const promise = createHighlighterCore({
    themes: [{ name: "bb-current", type: theme.type, fg: theme.fg, bg: theme.bg, colors: { ...theme.colors }, tokenColors: theme.tokenColors.map((rule) => ({ ...rule, scope: typeof rule.scope === "string" ? rule.scope : rule.scope ? [...rule.scope] : undefined })) }],
    langs: [ts, tsx, js, json, python],
    engine: createJavaScriptRegexEngine(),
  });
  highlighters.set(theme, promise);
  promise.catch(() => highlighters.delete(theme));
  return promise;
}

/** Render comment anchors in the patch and use BB's active code theme. */
export function InlineReviewDiff({ patch, path, renderLine, onAdd }: { patch: string; path: string; renderLine?: (side: Side, line: number) => ReactNode; onAdd?: (side: Side, line: number) => void }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const { theme, mode } = experimental_useCodeTheme();
  const [highlighted, setHighlighted] = useState<{ key: string; tokens: ThemedToken[][] } | null>(null);
  const lang = language(path);
  const key = `${path}\0${patch}\0${theme?.name ?? ""}`;
  useEffect(() => {
    let cancelled = false;
    if (!theme || !lang || patch.length > 400_000) return;
    const source = rows.filter((row) => row.tokenIndex !== undefined).map((row) => row.text.slice(1)).join("\n");
    highlighterFor(theme).then((highlighter) => {
      const tokens = highlighter.codeToTokens(source, { lang, theme: "bb-current" }).tokens;
      if (!cancelled) setHighlighted({ key, tokens });
    }).catch(() => { if (!cancelled) setHighlighted(null); });
    return () => { cancelled = true; };
  }, [theme, lang, key, patch, rows]);
  return <div className="gs-inline-diff" data-code-mode={mode} aria-label="Inline comment diff">{rows.map((row, index) => row.side && row.line !== null ? <div key={index}>
    <div className={`gs-inline-row gs-inline-${row.kind}`}>
      {onAdd ? <button type="button" className="gs-inline-add-button" aria-label={`Add comment on ${row.side} line ${row.line}`} onClick={() => onAdd(row.side!, row.line!)}>＋</button> : <span aria-hidden="true" />}
      <span className="gs-inline-number">{row.oldLine ?? ""}</span><span className="gs-inline-number">{row.newLine ?? ""}</span><code><span className="gs-inline-sign">{row.text[0]}</span>{highlighted?.key === key && row.tokenIndex !== undefined && highlighted.tokens[row.tokenIndex] ? highlighted.tokens[row.tokenIndex]!.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: token.color }}>{token.content}</span>) : row.text.slice(1)}</code>
    </div>{row.kind === "context" && row.oldLine !== null ? renderLine?.("old", row.oldLine) : null}{renderLine?.(row.side, row.line)}
  </div> : row.text ? <div key={index} className={`gs-inline-meta gs-inline-${row.kind}`}>{row.text}</div> : null)}</div>;
}
