import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createHookContext } from "../src/hook-context";
import { registerToolHooks } from "../src/hooks/tool-hooks";

for (const hookEventName of ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const) {
  test(`${hookEventName} context reaches the next model step in the first user turn`, async () => {
    type Handler = (event: unknown, ctx: ExtensionContext) => Promise<{ block?: boolean; reason?: string } | void>;
    const handlers = new Map<string, Handler>();
    const pending: Promise<unknown>[] = [];
    let session: AgentSession;
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      sendMessage: (
        message: Parameters<ExtensionAPI["sendMessage"]>[0],
        options: Parameters<ExtensionAPI["sendMessage"]>[1],
      ) => {
        pending.push(session.sendCustomMessage(message, options));
      },
    } as unknown as ExtensionAPI;
    const reminder = `Query Graphify before reading source: ${hookEventName}`;
    const shared = createHookContext(pi, async () => ({ hooks: {
      [hookEventName]: [{ matcher: "Bash", hooks: [{
        type: "command", command: `printf '%s' '${JSON.stringify({
          hookSpecificOutput: { hookEventName, additionalContext: reminder },
        })}'`,
      }] }],
    } }));
    registerToolHooks(pi, shared);
    const sessionManager = SessionManager.inMemory();
    const ctx = {
      cwd: process.cwd(), sessionManager, hasUI: false,
      ui: { notify: () => {} },
      isProjectTrusted: () => true,
      isIdle: () => !session.isStreaming,
    } as unknown as ExtensionContext;
    const completed: string[] = [];
    const parameters = type({});
    const tool: AgentTool<typeof parameters> = {
      name: "bash", label: "Bash", description: "Deterministic tool for delivery checks", parameters,
      execute: async (toolCallId) => {
        const event = { toolName: "bash", toolCallId, input: {} };
        const decision = await handlers.get("tool_call")!(event, ctx);
        if (decision?.block) throw new Error(decision.reason);
        completed.push(toolCallId);
        const result = {
          content: [{ type: "text" as const, text: `completed ${toolCallId}` }],
          details: {}, isError: hookEventName === "PostToolUseFailure",
        };
        await handlers.get("tool_result")!({ ...event, ...result }, ctx);
        return result;
      },
    };
    const mock = createMockModel({ responses: [
      { content: [
        { type: "toolCall", id: "first", name: "bash", arguments: {} },
        { type: "toolCall", id: "second", name: "bash", arguments: {} },
      ] },
      { content: ["Finished first turn"] },
    ] });
    const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
    const agent = new Agent({
      getApiKey: () => "test-key", streamFn: mock.stream,
      convertToLlm,
      initialState: { model, systemPrompt: ["Test"], tools: [tool] },
    });
    const auth = await AuthStorage.create(":memory:");
    auth.setRuntimeApiKey("anthropic", "test-key");
    session = new AgentSession({
      agent, sessionManager, settings: Settings.isolated({ "compaction.enabled": false }),
      modelRegistry: new ModelRegistry(auth),
    });
    try {
      await session.prompt("Inspect the source");
      expect(completed.sort()).toEqual(["first", "second"]);
      expect(mock.calls).toHaveLength(2);
      const nextStep = JSON.stringify(mock.calls[1].context.messages);
      // Claude Code 2.1.277 renders hook context as a system reminder that names the
      // hook and the tool: `<system-reminder>\n${hookName} hook additional context: …`.
      const labelled = `<system-reminder>\n${hookEventName}:Bash hook additional context: ${reminder}\n</system-reminder>`;
      expect(nextStep).toContain(JSON.stringify(labelled).slice(1, -1));
      expect(nextStep.split(reminder)).toHaveLength(2);
      expect(nextStep).toContain("completed first");
      expect(nextStep).toContain("completed second");
      expect(nextStep).not.toContain("Skipped due to pending system advisory");
    } finally {
      await Promise.all(pending);
      await session.dispose();
      auth.close();
      shared.dispose();
    }
  });
}
