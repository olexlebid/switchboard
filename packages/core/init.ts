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

// ---- existing projects: the project already has its own CLAUDE.md, so the shared files only point to it.

/** Where a project usually keeps its design tokens (first match wins). */
const TOKEN_FILES = ['src/styles/tokens.css', 'src/styles/variables.css', 'src/styles/global.css', 'tailwind.config.mjs', 'tailwind.config.ts', 'tailwind.config.js'];

const POINTER_RULES = `# Project rules

The full project rules live in **CLAUDE.md**. Read it completely before any task and follow it
(stack, naming, code style, language rules, quality bar).

## Switchboard overrides
You run headless, started by the Switchboard orchestrator. Where CLAUDE.md talks about workflow, these
rules win:
- Work on the git branch you are on (\`sb/...\`). Do NOT create branches, commit, push, merge or deploy:
  the orchestrator commits for you. CLAUDE.md lines like "commit straight to main" or "pull first" do not apply.
- Nobody is available to answer while you work: do not wait for approval or ask for a plan sign-off.
  If something is missing or unclear, write it under "Open questions" in PROGRESS.md and continue.
- Do not install or remove dependencies and do not edit netlify.toml or .env files.
`;

const pointerDesign = (tokenFile: string | undefined) => `# Design

The design system and tokens are described in **CLAUDE.md**${tokenFile ? ` and defined in \`${tokenFile}\`` : ''}.
Use the existing tokens only: no hard-coded colors, sizes or spacing.
If a state, breakpoint or animation is not described and not visible in the attached screenshots,
do not invent it: list it under "Open questions" in PROGRESS.md.
`;

const POINTER_AGENTS = `# Agent instructions

Read CLAUDE.md (full project rules), then RULES.md (how to behave under the Switchboard orchestrator)
and DESIGN.md (where the design tokens live) before writing any code.
Task details are in .sb/tasks/ and progress notes are in PROGRESS.md.
`;

export type InitResult = { created: string[]; skipped: string[]; warnings: string[]; mode: 'new' | 'existing' };

export function initProject(project: string): InitResult {
  // A project that already has its own CLAUDE.md (and no RULES.md yet) is an existing project:
  // create thin pointer files instead of TODO templates, so every agent learns the real rules.
  const existing = existsSync(join(project, 'CLAUDE.md')) && !existsSync(join(project, 'RULES.md'));
  const result: InitResult = { created: [], skipped: [], warnings: [], mode: existing ? 'existing' : 'new' };
  const tokenFile = TOKEN_FILES.find((f) => existsSync(join(project, f)));
  const files: [string, string][] = existing
    ? [
        ['RULES.md', POINTER_RULES],
        ['DESIGN.md', pointerDesign(tokenFile)],
        ['AGENTS.md', POINTER_AGENTS],
        [join('.sb', 'tasks', '.gitkeep'), ''],
      ]
    : [
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
  if (existing && !tokenFile) result.warnings.push('Не знайшов файл з токенами дизайну (src/styles/tokens.css тощо): DESIGN.md посилається лише на CLAUDE.md.');
  if (result.skipped.includes('CLAUDE.md') && !existing) {
    result.warnings.push('CLAUDE.md already exists: add the line `@RULES.md` to it so Claude Code loads the shared rules.');
  }
  if (result.skipped.includes('AGENTS.md')) {
    result.warnings.push('AGENTS.md already exists: make sure it tells agy to read RULES.md and DESIGN.md.');
  }
  return result;
}
