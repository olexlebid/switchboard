// `sb init <project>`: creates the rule/design/task scaffolding in an Astro project without
// overwriting anything that already exists.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RULES_MD = `# Project rules

> Fill in the TODO items once. Every AI agent reads this file before it starts a task.

## Stack
- Astro (static pages). TODO: Tailwind or plain CSS? (state one and forbid the other)
- Package manager: TODO (pnpm / npm). Do not add dependencies without an explicit task.

## Structure
- Pages: \`src/pages\`. Reusable blocks: \`src/components\` (one component = one file). Layouts: \`src/layouts\`.
- Styles: TODO (e.g. \`src/styles/tokens.css\`, \`global.css\`).
- Images: \`src/assets\`, rendered through \`astro:assets\` with width and height set.

## Naming and code style
- CSS classes: BEM, lowercase (\`block\`, \`block__element\`, \`block--modifier\`).
- Section markup: \`<section class="name section"><div class="container">...\`.
- Colors, spacing, radii and font sizes come from the tokens in DESIGN.md only. No magic values.
- Comments in code are written in English.

## Quality
- Semantic HTML, one \`h1\` per page, visible keyboard focus, alt text on images, \`prefers-reduced-motion\` respected.
- \`build\` must finish without errors.

## Never
- Do not touch \`netlify.toml\`, \`.env*\`, CI files or anything outside this project directory.
- Do not commit, push, merge or deploy. Do not run destructive commands.
`;

const DESIGN_MD = `# Design tokens

> Copy the values from Figma Variables. Agents must use these tokens instead of raw values.

## Colors
- TODO: \`--color-bg\`, \`--color-text\`, \`--color-accent\` ...

## Typography
- TODO: font families, sizes (scale), line-height, letter-spacing.

## Spacing and radius
- TODO: spacing scale, container max-width, section vertical padding, radii.

## Breakpoints
- TODO: e.g. 390 / 1024 / 1440.

## Figma
- TODO: link to the Figma file and the frames agents may use.
`;

const CLAUDE_MD = `@RULES.md

Read DESIGN.md for design tokens before writing any UI code.
`;

const AGENTS_MD = `# Agent instructions

Read RULES.md (project rules) and DESIGN.md (design tokens) before writing any code.
Task details are in .sb/tasks/ and progress notes are in PROGRESS.md.
`;

export type InitResult = { created: string[]; skipped: string[]; warnings: string[] };

export function initProject(project: string): InitResult {
  const result: InitResult = { created: [], skipped: [], warnings: [] };
  const files: [string, string][] = [
    ['RULES.md', RULES_MD],
    ['DESIGN.md', DESIGN_MD],
    ['CLAUDE.md', CLAUDE_MD],
    ['AGENTS.md', AGENTS_MD],
    [join('.sb', 'tasks', '.gitkeep'), ''],
  ];
  for (const [rel, content] of files) {
    const path = join(project, rel);
    if (existsSync(path)) {
      result.skipped.push(rel);
      continue;
    }
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    result.created.push(rel);
  }
  if (result.skipped.includes('CLAUDE.md')) {
    result.warnings.push('CLAUDE.md already exists: add the line `@RULES.md` to it so Claude Code loads the shared rules.');
  }
  if (result.skipped.includes('AGENTS.md')) {
    result.warnings.push('AGENTS.md already exists: make sure it tells agy to read RULES.md and DESIGN.md.');
  }
  return result;
}
