import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Glyph names that the installed BB host registers (core icon map plus
// icon-extended, BB with plugin SDK 0.6.94). An unknown name renders the Zap
// fallback, so every name in the UI source must be in this list.
const HOST_ICONS = new Set([
  "AlertTriangle",
  "ArrowReloadHorizontal",
  "Check",
  "ChevronDown",
  "ChevronUp",
  "CircleX",
  "ExternalLink",
  "FileText",
  "GitBranch",
  "GitPullRequest",
  "Info",
  "Layers",
  "Link",
  "Lock",
  "MessageSquare",
  "MessageSquarePlus",
  "Plus",
  "Repeat",
  "RotateCcw",
  "Sent",
  "Spinner",
  "Terminal",
  "X",
]);

const root = path.resolve(import.meta.dirname, "..");
const sources = [path.join(root, "app.tsx"), ...readdirSync(path.join(root, "ui")).filter((file) => file.endsWith(".tsx") && !file.includes(".test.")).map((file) => path.join(root, "ui", file))];

describe("icons", () => {
  it("uses only glyph names that the BB host registers", () => {
    const used = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      // Every capitalized string literal on a line that sets an icon.
      for (const line of text.split("\n")) {
        if (!/<Icon\b|\bicon[=:]|\bicon\s*=|\bicon=\{/u.test(line)) continue;
        const iconPart = line.replace(/\b(?:aria-label|title|label)=(?:"[^"]*"|\{[^}]*\})/gu, "");
        for (const match of iconPart.matchAll(/"([A-Z][A-Za-z0-9]+)"/gu)) used.add(match[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((name) => !HOST_ICONS.has(name)).sort()).toEqual([]);
  });
});
