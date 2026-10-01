import { describe, expect, it } from 'vitest';
import { interpretOutput } from '../packages/core/interpret';
import { buildStartPrompt } from '../packages/core/prompt';
import type { Task } from '../packages/core/types';

const task = { id: 't-1', text: 'Make a footer', type: 'section', branch: 'sb/t-1', priority: 'normal' } as Task;

describe('buildStartPrompt', () => {
  it('lists exactly the files that exist and says so', () => {
    const p = buildStartPrompt(task, { agent: 'claude', existing: ['RULES.md', 'DESIGN.md', '.sb/tasks/t-1.md'] });
    expect(p).toContain('1. RULES.md');
    expect(p).toContain('3. .sb/tasks/t-1.md');
    expect(p).toContain('Not present in this project: PROGRESS.md. Do not look for them; create PROGRESS.md when you finish.');
    expect(p).toContain('Task id: t-1');
    expect(p).toContain('Make a footer');
  });
  it('tells agy it has no shell, but not Claude', () => {
    const ctx = { existing: ['RULES.md', 'DESIGN.md', 'PROGRESS.md', '.sb/tasks/t-1.md'] };
    expect(buildStartPrompt(task, { ...ctx, agent: 'agy' })).toContain('NO shell access');
    expect(buildStartPrompt(task, { ...ctx, agent: 'claude' })).not.toContain('NO shell access');
  });
});

describe('agy denied action details', () => {
  const out = (a: Record<string, unknown>) => interpretOutput('agy', JSON.stringify({ status: 'SUCCESS', response: '', denied_actions: [a] }), '');
  it('shows the attempted command when agy reports it', () => {
    expect(out({ action: 'command', display_name: 'RunCommand', command: 'ls -la src' }).denied).toEqual(['command: ls -la src']);
  });
  it('falls back to the action name', () => {
    expect(out({ action: 'command', display_name: 'RunCommand' }).denied).toEqual(['command']);
  });
});
