import { afterEach, expect, jest, test } from 'bun:test';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { createHookContext, resetInjectedContext } from '../src/hook-context';
import { registerCompactHooks } from '../src/hooks/compact-hooks';

afterEach(() => { jest.useRealTimers(); resetInjectedContext(); });

test('compaction deduplicates matching hooks and restores distinct instructions each time', async () => {
  resetInjectedContext();
  jest.useFakeTimers();
  type Handler = (event: { compactionEntry: { summary: string } }, ctx: ExtensionContext) => Promise<void>;
  const handlers = new Map<string, Handler>();
  const messages: string[] = [];
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI;
  const shared = createHookContext(api);
  let postContext = 'Bootstrap instructions.';
  shared.settingsFor = async () => {
    const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: postContext } });
    shared.currentSettings = { hooks: {
      PostCompact: [{ hooks: [{ type: 'command', command: `printf '%s' '${output}'` }] }],
      SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: "printf 'Bootstrap instructions.'" }] }],
    } };
    return shared.currentSettings;
  };
  registerCompactHooks(api, shared);
  const ctx = {
    cwd: process.cwd(), sessionManager: { getSessionFile: () => 'compact-event' },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const compact = async () => {
    await handlers.get('session_compact')!({ compactionEntry: { summary: 'Summary' } }, ctx);
    jest.advanceTimersByTime(80);
    return messages.splice(0).join('\n\n');
  };
  expect(await compact()).toBe('Bootstrap instructions.');
  postContext = 'Post-compact instructions.';
  expect(await compact()).toBe('Post-compact instructions.\n\nBootstrap instructions.');
  expect(await compact()).toBe('Post-compact instructions.\n\nBootstrap instructions.');
});
