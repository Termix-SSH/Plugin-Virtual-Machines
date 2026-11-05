import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detailOf,
  parseAddresses,
  parseDomain,
  parseDomstats,
  parseSize,
  sections,
  snapshotBlock,
  stateOf,
  vmFromStats,
} from "../../src/backend/libvirt/parse.js";
import {
  parseInfo,
  parseInventory,
  parseLeases,
  parseNetworks,
  parseSnapshots,
  parseStatus,
  parseVolumes,
} from "../../src/backend/libvirt/read.js";

// Real output from libvirt 11.3 on Debian 13.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");

describe("inventory", () => {
  const inventory = parseInventory(fixture("inventory"));

  it("reads running and stopped VMs", () => {
    expect(inventory.vms.map((vm) => [vm.name, vm.state])).toEqual([
      ["fixture-a", "running"],
      ["fixture-b", "shutoff"],
    ]);
    const running = inventory.vms[0];
    expect(running.uuid).toBe("a0807dfb-b54d-4620-a64a-26762c1df25a");
    expect(running.vcpus).toBe(1);
    expect(running.maxMemoryKib).toBe(262144);
    expect(running.disks[0].target).toBe("vda");
    expect(running.nics[0].name).toMatch(/^vnet/);
    expect(running.ips.length).toBeGreaterThan(0);
  });

  it("reads the host and pools", () => {
    expect(inventory.node.cpus).toBe(4);
    expect(inventory.node.memoryKib).toBe(6070148);
    expect(inventory.pools[0].name).toBe("default");
    expect(inventory.pools[0].state).toBe("running");
    expect(inventory.pools[0].capacity).toBeGreaterThan(1024 ** 3);
  });
});

describe("states", () => {
  it("counts a VM that shut off from a crash as crashed", () => {
    expect(stateOf(5, 3)).toBe("crashed");
    expect(stateOf(5, 6)).toBe("crashed");
    expect(stateOf(5, 1)).toBe("shutoff");
    expect(stateOf(6, 1)).toBe("crashed");
    expect(stateOf(1, 1)).toBe("running");
    expect(stateOf(99, 0)).toBe("unknown");
  });

  it("has no memory use for a VM with no balloon numbers", () => {
    const stats = parseDomstats(["Domain: 'x'", "  state.state=5"]);
    expect(
      vmFromStats("u", "x", stats.get("x") as Map<string, string>, false, [])
        .usedKib,
    ).toBeNull();
  });
});

describe("domain xml", () => {
  const parts = sections(fixture("detail"));
  const domain = parseDomain((parts.get("xml") ?? []).join("\n"));

  it("reads devices", () => {
    expect(domain.machine).toMatch(/^pc-q35/);
    expect(domain.firmware).toBe("bios");
    expect(domain.diskDevices[0]).toMatchObject({
      device: "disk",
      target: "vda",
      bus: "virtio",
      format: "qcow2",
    });
    expect(domain.nicDevices[0]).toMatchObject({
      type: "network",
      source: "default",
      model: "virtio",
    });
    expect(domain.graphics[0]).toMatchObject({
      type: "vnc",
      port: 5900,
      address: "127.0.0.1",
      hasPassword: false,
    });
    expect(domain.hasSerial).toBe(true);
    expect(domain.guestAgent).toBe(false);
  });

  it("reads autostart and persistence", () => {
    const info = parseInfo(parts.get("info") ?? []);
    expect(info.Autostart).toBe("disable");
    expect(info.Persistent).toBe("yes");
  });

  it("finds a VNC password only in security info output", () => {
    const facts = parseDomain(
      `<domain><devices><graphics type='vnc' port='5901' passwd='s3cret'><listen type='address' address='127.0.0.1'/></graphics></devices></domain>`,
    );
    expect(facts.vncPassword).toBe("s3cret");
    expect(facts.graphics[0].hasPassword).toBe(true);
  });

  it("never passes the password to the detail view", () => {
    const facts = parseDomain(
      `<domain><devices><graphics type='vnc' port='5901' passwd='s3cret'/></devices></domain>`,
    );
    const row = vmFromStats("u", "x", new Map(), false, []);
    expect(JSON.stringify(detailOf(row, facts, true, false))).not.toContain(
      "s3cret",
    );
  });

  it("sees a socket display and block and network disks", () => {
    const facts = parseDomain(`<domain><devices>
      <disk type='block' device='disk'><driver type='raw'/><source dev='/dev/vg/a'/><target dev='vda' bus='virtio'/></disk>
      <disk type='network' device='disk'><driver type='raw'/><source protocol='rbd' name='pool/a'/><target dev='vdb' bus='virtio'/></disk>
      <graphics type='vnc'><listen type='socket' socket='/run/a.sock'/></graphics>
    </devices></domain>`);
    expect(facts.diskDevices.map((d) => d.source)).toEqual([
      "/dev/vg/a",
      "pool/a",
    ]);
    expect(facts.graphics[0].address).toBe("");
  });
});

describe("snapshot rules", () => {
  const disk = (format: string, device = "disk", readOnly = false) => ({
    device,
    target: "vda",
    bus: "virtio",
    source: "/a",
    format,
    readOnly,
  });

  it("needs qcow2 on every writable disk", () => {
    expect(snapshotBlock([disk("qcow2")])).toBe("");
    expect(snapshotBlock([disk("raw")])).toContain("qcow2");
    expect(snapshotBlock([disk("raw", "cdrom", true)])).toBe("");
  });

  it("blocks a running UEFI VM with a raw nvram only while it runs", () => {
    expect(snapshotBlock([disk("qcow2")], true, true)).toContain("UEFI");
    expect(snapshotBlock([disk("qcow2")], true, false)).toBe("");
    expect(
      parseDomain(
        `<domain><os firmware='efi'><nvram format='qcow2'>/a</nvram></os></domain>`,
      ).rawNvram,
    ).toBe(false);
    expect(parseDomain(`<domain><os firmware='efi'/></domain>`).rawNvram).toBe(
      true,
    );
  });
});

describe("other reads", () => {
  it("reads snapshots", () => {
    expect(parseSnapshots(fixture("snapshots"))).toEqual([
      {
        name: "snap1",
        parent: "",
        current: true,
        state: "running",
        description: "first",
        createdAt: "2026-11-05T19:22:31.000Z",
      },
    ]);
  });

  it("reads networks", () => {
    expect(parseNetworks(fixture("networks"))[0]).toMatchObject({
      name: "default",
      active: true,
      autostart: true,
      mode: "nat",
      bridge: "virbr0",
      subnet: "192.168.122.1",
      dhcp: true,
    });
  });

  it("reads volumes", () => {
    const rows = parseVolumes(fixture("volumes"));
    expect(rows[0]).toMatchObject({ name: "cirros.qcow2", type: "file" });
    expect(rows[0].capacity).toBe(117440512);
  });

  it("reads the host status", () => {
    expect(parseStatus(fixture("status"))).toMatchObject({
      installed: true,
      connected: true,
      kvm: true,
      serviceActive: true,
      version: "11.3.0",
      packageManager: "apt-get",
      missingTools: [],
      uefi: true,
    });
  });

  it("shows why libvirt could not be reached", () => {
    const status = parseStatus(
      "@@status\ninstalled=1\nmissing=genisoimage\nconnected=0\n@@error\nerror: Failed to connect\n",
    );
    expect(status.connected).toBe(false);
    expect(status.missingTools).toEqual(["genisoimage"]);
    expect(status.error).toContain("Failed to connect");
  });

  it("reads leases with and without a host name", () => {
    expect(
      parseLeases(
        " 2026-11-05 20:22:31   52:54:00:2f:07:c0   ipv4       192.168.122.213/24   -          01:52:54\n",
      )[0],
    ).toMatchObject({ ip: "192.168.122.213/24", hostname: "" });
  });

  it("drops loopback and link local addresses", () => {
    expect(
      parseAddresses([
        " lo         00:00:00:00:00:00    ipv4         127.0.0.1/8",
        " -          -                    ipv6         fe80::1/64",
        " vnet0      52:54:00:2f:07:c0    ipv4         192.168.122.5/24",
        " vnet0      52:54:00:2f:07:c0    ipv4         192.168.122.5/24",
      ]),
    ).toEqual(["192.168.122.5"]);
  });

  it("reads sizes", () => {
    expect(parseSize("1.00 GiB")).toBe(1024 ** 3);
    expect(parseSize("512 B")).toBe(512);
    expect(parseSize("-")).toBe(0);
  });
});
