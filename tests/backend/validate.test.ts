import { describe, expect, it } from "vitest";
import { parseHostSettings } from "../../src/backend/host-settings.js";
import {
  parseCidr,
  parseNewVm,
  requireMac,
  requireName,
  requireNewName,
  requirePath,
  requireTarget,
  requireUrl,
  requireUuid,
} from "../../src/backend/validate.js";

const input = (overrides: Record<string, unknown> = {}) => ({
  name: "web-1",
  vcpus: 2,
  memoryMib: 1024,
  diskGib: 10,
  pool: "default",
  network: { type: "network", source: "default" },
  source: {
    type: "cloud",
    image: "debian-13",
    username: "admin",
    password: "x",
    sshKey: "",
  },
  ...overrides,
});

describe("names", () => {
  it("takes a uuid only", () => {
    expect(requireUuid("a0807dfb-b54d-4620-a64a-26762c1df25a")).toBeTruthy();
    expect(() => requireUuid("--force")).toThrow();
    expect(() => requireUuid("$(id)")).toThrow();
  });

  it("is strict with new names", () => {
    expect(requireNewName("web-1.test")).toBe("web-1.test");
    for (const bad of ["", "-a", "a b", "a/b", "../a", "a;b", "a'b"]) {
      expect(() => requireNewName(bad)).toThrow();
    }
  });

  it("allows spaces in names that already exist, but no flags or paths", () => {
    expect(requireName("my pool")).toBe("my pool");
    for (const bad of ["", "--pool", "a/b", "a\nb"]) {
      expect(() => requireName(bad)).toThrow();
    }
  });

  it("checks macs, targets, paths and urls", () => {
    expect(requireMac("52:54:00:2F:07:C0")).toBe("52:54:00:2f:07:c0");
    expect(() => requireMac("nope")).toThrow();
    expect(requireTarget("vdb")).toBe("vdb");
    expect(() => requireTarget("../a")).toThrow();
    expect(requirePath("/srv/my vms")).toBe("/srv/my vms");
    expect(() => requirePath("srv")).toThrow();
    expect(() => requirePath("/srv/../etc")).toThrow();
    expect(requireUrl("https://a.test/b.iso")).toBeTruthy();
    expect(() => requireUrl("file:///etc/passwd")).toThrow();
    expect(() => requireUrl("nope")).toThrow();
  });
});

describe("networks", () => {
  it("works out a DHCP range", () => {
    expect(parseCidr("192.168.50.1/24")).toEqual({
      address: "192.168.50.1",
      netmask: "255.255.255.0",
      dhcpStart: "192.168.50.2",
      dhcpEnd: "192.168.50.254",
    });
    expect(parseCidr("10.1.2.1/16").netmask).toBe("255.255.0.0");
  });

  it("refuses bad networks", () => {
    for (const bad of [
      "300.1.1.1/24",
      "10.0.0.1",
      "10.0.0.0/24",
      "10.0.0.1/31",
    ]) {
      expect(() => parseCidr(bad)).toThrow();
    }
  });
});

describe("new VMs", () => {
  it("takes a good VM", () => {
    expect(parseNewVm(input())).toMatchObject({
      name: "web-1",
      firmware: "bios",
      start: true,
      autostart: false,
    });
  });

  it("needs a login on a cloud image", () => {
    expect(() =>
      parseNewVm(
        input({
          source: { type: "cloud", image: "x", username: "a", password: "" },
        }),
      ),
    ).toThrow(/password or an SSH key/);
  });

  it("refuses a bad login name, key or password", () => {
    const source = { type: "cloud", image: "x", password: "x" };
    expect(() =>
      parseNewVm(input({ source: { ...source, username: "root; id" } })),
    ).toThrow();
    expect(() =>
      parseNewVm(
        input({
          source: {
            ...source,
            username: "a",
            sshKey: "ssh-ed25519 AAAA\n- evil",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseNewVm(
        input({ source: { ...source, username: "a", password: "a\nb" } }),
      ),
    ).toThrow();
  });

  it("refuses sizes out of range", () => {
    expect(() => parseNewVm(input({ vcpus: 0 }))).toThrow();
    expect(() => parseNewVm(input({ memoryMib: 1 }))).toThrow();
    expect(() => parseNewVm(input({ diskGib: 1.5 }))).toThrow();
  });

  it("checks a bridge name", () => {
    expect(() =>
      parseNewVm(input({ network: { type: "bridge", source: "br0; id" } })),
    ).toThrow();
  });
});

describe("host settings", () => {
  it("defaults", () => {
    expect(parseHostSettings({})).toEqual({
      enabled: false,
      sudo: true,
      readOnly: false,
      uri: "qemu:///system",
    });
  });

  it("ignores a connection that is not a uri", () => {
    expect(parseHostSettings({ connectUri: "qemu:///session" }).uri).toBe(
      "qemu:///session",
    );
    expect(parseHostSettings({ connectUri: "x; id" }).uri).toBe(
      "qemu:///system",
    );
  });
});
