// Prompt templates live as Markdown in ./prompts and are filled with {{name}} slots.
// Untrusted source text (filing names, entity names, anything read from a source) is
// fenced in <source_text> tags; any copy of those tags inside the text is neutralised so
// the text cannot close its own fence.
// Adapted from ClearShelf (same author, Apache-2.0).

import { readFileSync } from "node:fs";

export type PromptName = "planner" | "memo";

const cache = new Map<PromptName, string>();

export function loadPrompt(name: PromptName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text: string = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8").replace(/\r\n/gu, "\n");
  cache.set(name, text);
  return text;
}

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (_, key: string) => {
    if (!(key in vars)) throw new Error(`prompt slot {{${key}}} has no value`);
    return vars[key];
  });
}

export function fenceUntrusted(text: string): string {
  const safe = text.replace(/<\/?\s*source_text\s*>/giu, "[tag removed]");
  return `<source_text>\n${safe}\n</source_text>`;
}

/** What the planner is told about one tool. */
export interface ToolSpec {
  name: string;
  description: string;
  input: string;
  completes: string[];
}

export function toolLines(tools: readonly ToolSpec[]): string {
  return tools
    .map((t) => `- ${t.name}: ${t.description} Input: ${t.input}. Completes: ${t.completes.join(", ") || "nothing on its own"}.`)
    .join("\n");
}
