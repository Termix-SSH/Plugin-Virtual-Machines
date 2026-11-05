import { describe, expect, it } from "vitest";
import { parseManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../manifest.json";
import locales from "../../locales/en.json";
import {
  registerOperations,
  type OperationDeps,
} from "../../src/backend/operations.js";

interface Action {
  id: string;
  risk: string;
  hostAccess?: string;
  titleKey: string;
  surfaces?: { assistant?: boolean; mcp?: boolean };
}
const operations = (
  manifest.contributes as unknown as {
    operations: { actions: Action[]; events: Array<{ titleKey: string }> };
  }
).operations;

const resolves = (key: string) =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      locales,
    ) !== undefined;

describe("declared actions", () => {
  it("is a valid manifest", () => {
    expect(parseManifest(manifest).errors ?? []).toEqual([]);
  });

  it("has a handler for every declared action and nothing else", () => {
    const registered: string[] = [];
    const ctx = {
      operations: {
        register: (id: string) => {
          registered.push(id);
        },
      },
    } as unknown as PluginContext;
    registerOperations(ctx, {} as OperationDeps);
    expect([...registered].sort()).toEqual(
      operations.actions.map((action) => action.id).sort(),
    );
  });

  it("needs edit for anything destructive", () => {
    for (const action of operations.actions) {
      if (action.risk === "destructive") {
        expect(["edit", "manage"]).toContain(action.hostAccess);
      }
    }
  });

  it("never offers a destructive action to a model", () => {
    for (const action of operations.actions) {
      if (action.risk === "destructive") {
        expect(action.surfaces?.assistant).not.toBe(true);
        expect(action.surfaces?.mcp).not.toBe(true);
      }
    }
  });

  it("has text for every action and event", () => {
    for (const item of [...operations.actions, ...operations.events]) {
      expect(resolves(item.titleKey), item.titleKey).toBe(true);
    }
  });
});
