import { describe, expect, it, vi } from "vitest";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import {
  registerTreeChildren,
  toTreeChildren,
  treeState,
} from "../../src/frontend/tree-children";

describe("host tree children", () => {
  it("maps libvirt states to tree states", () => {
    expect(treeState("running")).toBe("running");
    expect(treeState("blocked")).toBe("running");
    expect(treeState("paused")).toBe("paused");
    expect(treeState("pmsuspended")).toBe("paused");
    expect(treeState("shutoff")).toBe("stopped");
    expect(treeState("crashed")).toBe("stopped");
    expect(treeState("unknown")).toBe("unknown");
  });

  it("turns VMs into items that open the VM tab on them, by name", () => {
    expect(
      toTreeChildren([
        { uuid: "u2", name: "web", state: "running", ips: ["10.0.0.5"] },
        { uuid: "u1", name: "db", state: "shutoff", ips: [] },
      ]),
    ).toEqual([
      {
        id: "u1",
        label: "db",
        detail: undefined,
        kind: "vm",
        state: "stopped",
        tabType: "virtual-machines",
        data: { focus: { uuid: "u1" } },
      },
      {
        id: "u2",
        label: "web",
        detail: "10.0.0.5",
        kind: "vm",
        state: "running",
        tabType: "virtual-machines",
        data: { focus: { uuid: "u2" } },
      },
    ]);
  });

  it("registers only on a Termix that has host trees", () => {
    const when = () => true;
    expect(() => registerTreeChildren({} as TermixApp, when)).not.toThrow();
    const registerHostTreeChildren = vi.fn();
    registerTreeChildren(
      { registerHostTreeChildren } as unknown as TermixApp,
      when,
    );
    expect(registerHostTreeChildren).toHaveBeenCalledWith(
      expect.objectContaining({ id: "vms", when }),
    );
  });
});
