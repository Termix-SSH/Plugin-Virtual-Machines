import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { Inventory, VmRow, VmState } from "../../src/shared/types.js";
import {
  createInventory,
  diffStates,
  isUp,
  type InventoryStore,
  type Transition,
} from "../../src/backend/inventory.js";
import type { VmProvider } from "../../src/backend/provider.js";
import {
  alertFor,
  WatchChecker,
  type WatchStore,
} from "../../src/backend/watches.js";

const vm = (state: VmState, uuid = "u1"): VmRow =>
  ({ uuid, name: "web", state }) as VmRow;
const inventory = (
  vms: VmRow[],
  pools: Inventory["pools"] = [],
): Inventory => ({
  vms,
  pools,
  node: { cpus: 1, memoryKib: 1, freeKib: 1 },
  checkedAt: "",
});
const change = (over: Partial<Transition>): Transition => ({
  hostId: 1,
  uuid: "u1",
  name: "web",
  from: "running",
  to: "shutoff",
  expected: false,
  ...over,
});
const target = {
  hostId: 1,
  settings: { enabled: true, sudo: true, readOnly: false, uri: "x" },
};

describe("state changes", () => {
  it("finds changes, and skips new VMs", () => {
    const out = diffStates(
      1,
      inventory([vm("running")]),
      inventory([vm("shutoff"), vm("running", "u2")]),
      () => false,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: "running", to: "shutoff" });
  });

  it("knows what counts as up", () => {
    expect(isUp("paused")).toBe(true);
    expect(isUp("crashed")).toBe(false);
  });

  it("alerts on a stop Termix did not do", () => {
    expect(alertFor(change({}))?.kind).toBe("stopped");
    expect(alertFor(change({ expected: true }))).toBeNull();
    expect(alertFor(change({ from: "shutoff", to: "running" }))).toBeNull();
  });

  it("always alerts on a crash", () => {
    expect(alertFor(change({ to: "crashed", expected: true }))?.severity).toBe(
      "critical",
    );
  });
});

describe("inventory cache", () => {
  const setup = () => {
    const read = vi.fn(async () => inventory([vm("running")]));
    const onRead = vi.fn();
    const store = createInventory(
      { inventory: read } as unknown as VmProvider,
      onRead,
    );
    return { read, onRead, store };
  };

  it("reads once inside the cache time", async () => {
    const { read, store } = setup();
    await store.get(target);
    await store.get(target);
    expect(read).toHaveBeenCalledTimes(1);
    await store.get(target, { fresh: true });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one read between callers", async () => {
    const { read, store } = setup();
    await Promise.all([store.get(target), store.get(target)]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("still sees a change after a cache drop, and marks it expected", async () => {
    const { read, onRead, store } = setup();
    await store.get(target);
    read.mockResolvedValue(inventory([vm("shutoff")]));
    store.expect(1, "u1");
    store.invalidate(1);
    await store.get(target);
    const changes = onRead.mock.calls[1][2] as Transition[];
    expect(changes[0]).toMatchObject({ to: "shutoff", expected: true });
  });
});

describe("alerts", () => {
  const setup = (rows: Array<{ userId: string; uuid: string }>) => {
    const send = vi.fn(async () => undefined);
    const emit = vi.fn();
    const ctx = {
      notify: { send },
      operations: { emit },
      hosts: { get: async () => ({ name: "kvm" }) },
      asUser: (_u: string, fn: () => unknown) => fn(),
      log: { warn: vi.fn(), debug: vi.fn() },
    } as unknown as PluginContext;
    const store = {
      listAll: async () =>
        rows.map((row) => ({ ...row, hostId: 1, name: "web" })),
    } as unknown as WatchStore;
    return {
      send,
      emit,
      checker: new WatchChecker(ctx, store, {} as InventoryStore),
    };
  };

  it("tells only the people watching that VM", async () => {
    const { send, checker } = setup([
      { userId: "a", uuid: "u1" },
      { userId: "b", uuid: "u2" },
    ]);
    await checker.onRead(1, inventory([]), [change({ to: "crashed" })]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toMatchObject([
      {
        title: "web crashed on kvm",
        severity: "critical",
        audience: { userId: "a" },
      },
    ]);
  });

  it("sends events with no one watching", async () => {
    const { send, emit, checker } = setup([]);
    await checker.onRead(1, inventory([]), [change({ expected: true })]);
    expect(send).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "virtual-machines.vm-stopped",
      expect.objectContaining({ uuid: "u1" }),
      { hostId: 1 },
    );
  });

  it("reports a full pool once until it has room again", async () => {
    const { send, checker } = setup([{ userId: "a", uuid: "u1" }]);
    const pool = (allocation: number) => [
      {
        name: "default",
        state: "running",
        autostart: true,
        capacity: 100,
        allocation,
        available: 100 - allocation,
      },
    ];
    await checker.onRead(1, inventory([], pool(95)), []);
    await checker.onRead(1, inventory([], pool(96)), []);
    expect(send).toHaveBeenCalledTimes(1);
    await checker.onRead(1, inventory([], pool(50)), []);
    await checker.onRead(1, inventory([], pool(95)), []);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
