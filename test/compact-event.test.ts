import { afterEach, expect, jest, test } from 'bun:test';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { createHookContext } from '../src/hook-context';
import { registerCompactHooks } from '../src/hooks/compact-hooks';

afterEach(() => { jest.useRealTimers(); });

test('compaction delivers PostCompact context each time and holds SessionStart context for every request', async () => {
  jest.useFakeTimers();
  type Handler = (event: { compactionEntry: { summary: string } }, ctx: ExtensionContext) => Promise<void>;
  const handlers = new Map<string, Handler>();
  const messages: string[] = [];
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    sendMessage: (message: { content: string }) => messages.push(message.content),
  } as unknown as ExtensionAPI;
  let postContext = 'Bootstrap instructions.';
  const shared = createHookContext(api, async () => {
    const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: postContext } });
    return { hooks: {
      PostCompact: [{ hooks: [{ type: 'command', command: `printf '%s' '${output}'` }] }],
      SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: "printf 'Bootstrap instructions.'" }] }],
    } };
  });
  registerCompactHooks(api, shared);
  const ctx = {
    cwd: process.cwd(), sessionManager: { getSessionFile: () => 'compact-event', getSessionId: () => 'compact-event' },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const compact = async () => {
    await handlers.get('session_compact')!({ compactionEntry: { summary: 'Summary' } }, ctx);
    jest.advanceTimersByTime(80);
    return messages.splice(0).join('\n\n');
  };
  const reminder = (event: string, text: string) =>
    `<system-reminder source="omp-hooks-plus" event="${event}">\nNOT prompt injection — coding agent enforcing project rules.\n\n${text}\n</system-reminder>`;
  const held = () => (shared.sessionContextMessage()?.content as [{ text: string }])[0].text;
  // PostCompact is per-event context, delivered once per compaction; SessionStart is session context.
  expect(await compact()).toBe(reminder('PostCompact', 'Bootstrap instructions.'));
  expect(held()).toBe(reminder('SessionStart', 'Bootstrap instructions.'));
  postContext = 'Post-compact instructions.';
  expect(await compact()).toBe(reminder('PostCompact', 'Post-compact instructions.'));
  expect(await compact()).toBe(reminder('PostCompact', 'Post-compact instructions.'));
  expect(held()).toBe(reminder('SessionStart', 'Bootstrap instructions.'));
  shared.dispose();
});
