import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webExtension from "./index.js";

describe("webExtension #unit", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createFakePI(): {
    pi: ExtensionAPI;
    registeredTools: unknown[];
    notifications: Array<{ message: string; type: string }>;
    triggerSessionStart: (hasUI: boolean) => Promise<void>;
  } {
    const registeredTools: unknown[] = [];
    const notifications: Array<{ message: string; type: string }> = [];
    const handlers = new Map<
      string,
      Array<(event: unknown, ctx: ExtensionContext) => Promise<void>>
    >();

    const pi = {
      registerTool: (tool: unknown) => registeredTools.push(tool),
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    } as unknown as ExtensionAPI;

    return {
      pi,
      registeredTools,
      notifications,
      triggerSessionStart: async (hasUI: boolean) => {
        const ctx = {
          mode: hasUI ? "tui" : "print",
          hasUI,
          ui: {
            notify: (message: string, type: string) => {
              notifications.push({ message, type });
            },
          },
        } as unknown as ExtensionContext;
        for (const handler of handlers.get("session_start") ?? []) {
          await handler({}, ctx);
        }
      },
    };
  }

  it("registers both tools and does not notify when the API key is present", async () => {
    const { pi, registeredTools, notifications, triggerSessionStart } = createFakePI();

    vi.stubEnv("TAVILY_API_KEY", "test-key");
    webExtension(pi);
    await triggerSessionStart(true);

    expect(registeredTools).toHaveLength(2);
    expect(registeredTools[0]).toMatchObject({ name: "web_search" });
    expect(registeredTools[1]).toMatchObject({ name: "web_extract" });
    expect(notifications).toHaveLength(0);
  });

  it("does not register tools and notifies once when the API key is missing", async () => {
    const { pi, registeredTools, notifications, triggerSessionStart } = createFakePI();

    vi.stubEnv("TAVILY_API_KEY", "");
    webExtension(pi);
    await triggerSessionStart(true);
    await triggerSessionStart(true);

    expect(registeredTools).toHaveLength(0);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("web_search");
    expect(notifications[0]?.message).toContain("web_extract");
    expect(notifications[0]?.type).toBe("warning");
  });

  it("does not notify in non-UI modes even when the API key is missing", async () => {
    const { pi, notifications, triggerSessionStart } = createFakePI();

    vi.stubEnv("TAVILY_API_KEY", "");
    webExtension(pi);
    await triggerSessionStart(false);

    expect(notifications).toHaveLength(0);
  });
});
