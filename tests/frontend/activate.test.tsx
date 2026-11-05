import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { vmsEnabled, vmsPanelEnabled } from "../../src/frontend/format";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const status = {
  installed: true,
  connected: true,
  kvm: true,
  serviceActive: true,
  version: "11.3.0",
  packageManager: "apt-get",
  missingTools: [],
  uefi: true,
  error: "",
};

const vm = {
  uuid: "a0807dfb-b54d-4620-a64a-26762c1df25a",
  name: "web-1",
  state: "running",
  reason: 1,
  vcpus: 2,
  memoryKib: 2097152,
  maxMemoryKib: 2097152,
  usedKib: 1048576,
  autostart: false,
  cpuTimeNs: 1,
  disks: [],
  nics: [],
  ips: ["192.168.122.5"],
};

const inventory = {
  vms: [vm],
  node: { cpus: 4, memoryKib: 8388608, freeKib: 1 },
  pools: [],
  checkedAt: "",
};

const detail = {
  ...vm,
  persistent: true,
  machine: "pc-q35-10.0",
  arch: "x86_64",
  firmware: "bios",
  cpuMode: "host-passthrough",
  description: "",
  diskDevices: [],
  nicDevices: [],
  graphics: [
    { type: "vnc", port: 5900, address: "127.0.0.1", hasPassword: false },
  ],
  hasSerial: true,
  guestAgent: false,
  canSnapshot: true,
  snapshotBlock: "",
  watched: false,
};

function api(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "/status": status,
    "/inventory": inventory,
    [`/vms/${vm.uuid}`]: detail,
    "/summary": [
      {
        hostId: 1,
        hostName: "kvm",
        total: 1,
        running: 1,
        stopped: 0,
        crashed: 0,
        vms: [vm],
        pools: [],
        error: "",
        checkedAt: "",
      },
    ],
    ...overrides,
  };
  return {
    get: vi.fn(async (url: string) => {
      const path = url.split("?")[0];
      for (const [key, value] of Object.entries(routes)) {
        if (path.endsWith(key)) return { data: value };
      }
      return { data: [] };
    }),
    post: vi.fn(async () => ({ data: { ok: true } })),
    put: vi.fn(async () => ({ data: { ok: true } })),
    patch: vi.fn(async () => ({ data: { ok: true } })),
    delete: vi.fn(async () => ({ data: { ok: true } })),
  } as never;
}

const host = {
  id: 1,
  name: "kvm",
  ip: "10.0.0.1",
  enableSsh: true,
  pluginSettings: { "virtual-machines": { enableVirtualMachines: true } },
};

describe(`${manifest.id} frontend`, () => {
  it("registers its tabs and dashboard card", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual([
      "virtual-machines",
      "virtual-machines-all",
    ]);
    expect(rendered.registered.dashboardCards()).toEqual(["vm-hosts"]);
  });

  it("only offers the tab and panel on hosts that turned it on", () => {
    expect(vmsEnabled(host)).toBe(true);
    expect(vmsEnabled({ pluginSettings: {} })).toBe(false);
    expect(vmsPanelEnabled(host)).toBe(true);
    expect(
      vmsPanelEnabled({
        pluginSettings: {
          "virtual-machines": {
            enableVirtualMachines: true,
            showPanel: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("lists VMs", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(),
    });
    rendered.renderTab("virtual-machines", { isVisible: true, host });
    expect(await screen.findByText("web-1")).toBeTruthy();
    expect(screen.getByText(locales.vm.new)).toBeTruthy();
  });

  it("offers an install when libvirt is missing", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({
        "/status": { ...status, installed: false, connected: false },
      }),
    });
    rendered.renderTab("virtual-machines", { isVisible: true, host });
    expect(await screen.findByText(locales.setup.missing)).toBeTruthy();
    expect(screen.getByText(locales.setup.install)).toBeTruthy();
  });

  it("opens a VM from the list", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(),
    });
    rendered.renderTab("virtual-machines", { isVisible: true, host });
    fireEvent.click(await screen.findByText("web-1"));
    expect(await screen.findByText(locales.vm.overview)).toBeTruthy();
    expect(screen.getByText(locales.vm.snapshots)).toBeTruthy();
  });

  it("shows hosts on the dashboard card", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(),
      permissions: ["virtual-machines.use"],
    });
    rendered.renderDashboardCard("vm-hosts");
    expect(await screen.findByText("kvm")).toBeTruthy();
  });

  it("shows every host's VMs", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(),
      permissions: ["virtual-machines.use"],
    });
    rendered.renderTab("virtual-machines-all", { isVisible: true });
    expect(await screen.findByText("web-1")).toBeTruthy();
    expect(screen.getByText("kvm")).toBeTruthy();
  });
});
