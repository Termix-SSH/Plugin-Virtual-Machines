import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockCtx, createTestDb } from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";

const manifest = manifestJson as unknown as PluginManifest;
const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const UUID = "a0807dfb-b54d-4620-a64a-26762c1df25a";
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");

type Level = "connect" | "edit" | "manage" | "none";

async function start(
  options: {
    level?: Level;
    hostSettings?: Record<string, unknown>;
    permissions?: string[];
    services?: Record<string, object>;
  } = {},
) {
  let router: Router | null = null;
  const db = await createTestDb(pluginDir);
  db.sqlite.exec(
    "INSERT INTO users (id) VALUES ('user-1'); INSERT INTO ssh_data (id) VALUES (1), (2);",
  );
  const mock = createMockCtx({
    sandbox: true,
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? [
      "virtual-machines.use",
      "virtual-machines.console",
    ],
    services: options.services,
  });
  mock.setActor("user-1");
  Object.assign(mock.ctx.settings, {
    getAll: async (scope: string) =>
      scope === "host"
        ? { enableVirtualMachines: true, ...options.hostSettings }
        : {},
  });
  const rank = { connect: 1, edit: 3, manage: 4, none: 0 } as const;
  const level = options.level ?? "manage";
  Object.assign(mock.ctx.hosts, {
    checkAccess: async (_id: number, need: "connect" | "edit" = "connect") => ({
      hasAccess: rank[level] >= rank[need],
      isOwner: true,
      isShared: false,
    }),
    get: async (id: number) => ({ id, name: "kvm", ip: "10.0.0.1" }),
    list: async () => [{ id: 1, name: "kvm", ip: "10.0.0.1", port: 22 }],
  });
  const calls: string[] = [];
  const replies: Array<{
    match: string;
    stdout?: string;
    stderr?: string;
    code?: number;
  }> = [];
  Object.assign(mock.ctx.ssh, {
    resolveHost: async () => ({}),
    exec: async (
      _host: number,
      _command: string,
      opts?: { stdin?: string },
    ) => {
      const stdin = opts?.stdin ?? "";
      calls.push(stdin);
      const reply = replies.find((r) => stdin.includes(r.match));
      return {
        stdout: reply?.stdout ?? "",
        stderr: reply?.stderr ?? "",
        code: reply?.code ?? 0,
        truncated: false,
        timedOut: false,
      };
    },
  });
  Object.assign(mock.ctx.operations, {
    run: vi.fn(async () => ({ status: "success", data: { done: true } })),
  });

  const { activate } = await import("../../src/backend/index.js");
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => router!(req, res, next));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const request = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (await res.json().catch(() => null)) as any,
    };
  };
  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  closers.push(close);
  return { mock, calls, replies, request };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const domainReply = (xml: string) => ({
  match: "--security-info",
  stdout: xml,
});

describe("access", () => {
  it("hides a host you can't reach", async () => {
    const { request } = await start({ level: "none" });
    expect((await request("GET", "/hosts/1/inventory")).status).toBe(404);
  });

  it("says when the host has it turned off", async () => {
    const { request } = await start({
      hostSettings: { enableVirtualMachines: false },
    });
    const response = await request("GET", "/hosts/1/inventory");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("disabled");
  });

  it("needs edit access for a change", async () => {
    const { request, mock } = await start({ level: "connect" });
    const response = await request("POST", `/hosts/1/vms/${UUID}/power/start`);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("HOST_EDIT_REQUIRED");
    expect(mock.ctx.operations.run).not.toHaveBeenCalled();
  });

  it("blocks changes on a read only host, not reads", async () => {
    const { request, replies } = await start({
      hostSettings: { readOnly: true },
    });
    replies.push({ match: "domstats", stdout: fixture("inventory") });
    expect((await request("GET", "/hosts/1/inventory")).status).toBe(200);
    const response = await request("DELETE", `/hosts/1/vms/${UUID}`);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("readOnly");
  });

  it("refuses an id that is not a uuid", async () => {
    const { request, calls } = await start();
    expect((await request("GET", "/hosts/1/vms/$(id)")).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("reads", () => {
  it("lists VMs", async () => {
    const { request, replies } = await start();
    replies.push({ match: "domstats", stdout: fixture("inventory") });
    const response = await request("GET", "/hosts/1/inventory");
    expect(response.body.vms.map((vm: { name: string }) => vm.name)).toEqual([
      "fixture-a",
      "fixture-b",
    ]);
  });

  it("sums up every host and keeps going when one fails", async () => {
    const { request, replies } = await start();
    replies.push({ match: "domstats", stdout: fixture("inventory") });
    const ok = await request("GET", "/summary");
    expect(ok.body[0]).toMatchObject({
      hostName: "kvm",
      total: 2,
      running: 1,
      stopped: 1,
      crashed: 0,
    });
    replies[0] = { match: "domstats", stderr: "error: boom", code: 1 };
    const down = await request("GET", "/summary?refresh=1");
    expect(down.status).toBe(200);
    expect(down.body[0].error).toContain("boom");
  });

  it("shows a VM with your watch on it", async () => {
    const { request, replies } = await start();
    replies.push({ match: "dominfo", stdout: fixture("detail") });
    await request("PUT", `/hosts/1/vms/${UUID}/watch`, {
      on: true,
      name: "fixture-a",
    });
    const response = await request("GET", `/hosts/1/vms/${UUID}`);
    expect(response.body).toMatchObject({
      name: "fixture-a",
      autostart: false,
      persistent: true,
      firmware: "bios",
      canSnapshot: true,
      watched: true,
    });
  });
});

describe("changes", () => {
  it("runs power through the operations gate", async () => {
    const { request, mock } = await start();
    const response = await request("POST", `/hosts/1/vms/${UUID}/power/stop`);
    expect(response.status).toBe(200);
    expect(mock.ctx.operations.run).toHaveBeenCalledWith(
      "virtual-machines.force-stop",
      { hostId: 1, confirmed: true, resourceKey: UUID },
    );
  });

  it("refuses an unknown power action", async () => {
    const { request } = await start();
    expect(
      (await request("POST", `/hosts/1/vms/${UUID}/power/explode`)).status,
    ).toBe(400);
  });

  it("passes a failed operation on", async () => {
    const { request, mock } = await start();
    (mock.ctx.operations.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "failed",
      error: "domain is not running",
    });
    const response = await request("POST", `/hosts/1/vms/${UUID}/power/reboot`);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("domain is not running");
  });

  it("only deletes disks when asked", async () => {
    const { request, mock } = await start();
    const run = mock.ctx.operations.run as ReturnType<typeof vi.fn>;
    await request("DELETE", `/hosts/1/vms/${UUID}`);
    await request("DELETE", `/hosts/1/vms/${UUID}?deleteDisks=1`);
    expect(run.mock.calls[0][1].input).toEqual({ deleteDisks: false });
    expect(run.mock.calls[1][1].input).toEqual({ deleteDisks: true });
  });

  it("starts a job for a new VM and keeps the password off disk", async () => {
    const { request, calls } = await start();
    const response = await request("POST", "/hosts/1/vms", {
      name: "web-1",
      vcpus: 1,
      memoryMib: 512,
      diskGib: 5,
      pool: "default",
      network: { type: "network", source: "default" },
      source: {
        type: "cloud",
        image: "debian-13",
        username: "admin",
        password: "hunter2",
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ kind: "create", status: "running" });
    const started = calls.find((call) => call.includes("setsid nohup"));
    expect(started).toBeTruthy();
    expect(started).not.toContain("hunter2");
    const list = await request("GET", "/hosts/1/jobs");
    expect(list.body[0].label).toBe("web-1");
  });

  it("refuses a bad new VM before touching the host", async () => {
    const { request, calls } = await start();
    const before = calls.length;
    expect(
      (await request("POST", "/hosts/1/vms", { name: "a b" })).status,
    ).toBe(400);
    expect(calls.length).toBe(before);
  });

  it("will not save XML that renames the VM", async () => {
    const { request, replies, calls } = await start();
    replies.push(
      domainReply(`<domain><name>a</name><uuid>${UUID}</uuid></domain>`),
    );
    const response = await request("PUT", `/hosts/1/vms/${UUID}/xml`, {
      xml: `<domain><name>b</name><uuid>${UUID}</uuid></domain>`,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Keep the name");
    expect(calls.some((call) => call.includes("define"))).toBe(false);
  });

  it("creates a network and refuses a bad address", async () => {
    const { request, calls } = await start();
    expect(
      (
        await request("POST", "/hosts/1/networks", {
          name: "lab",
          type: "nat",
          subnet: "192.168.50.1/24",
        })
      ).status,
    ).toBe(200);
    expect(calls.some((call) => call.includes("net-define"))).toBe(true);
    expect(
      (
        await request("POST", "/hosts/1/networks", {
          name: "lab",
          type: "nat",
          subnet: "nope",
        })
      ).status,
    ).toBe(400);
  });
});

describe("graphical console", () => {
  const xml = `<domain><devices><graphics type='vnc' port='5900' passwd='s3cret'><listen type='address' address='127.0.0.1'/></graphics></devices></domain>`;

  it("says when Remote Desktop is missing", async () => {
    const { request } = await start();
    const response = await request("POST", `/hosts/1/vms/${UUID}/console`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("no-remote-desktop");
  });

  it("hands the display to Remote Desktop and only returns a token", async () => {
    const open = vi.fn(async () => ({ token: "abc" }));
    const { request, replies } = await start({
      services: { "remote-desktop.console": { open } },
    });
    replies.push(domainReply(xml));
    const response = await request("POST", `/hosts/1/vms/${UUID}/console`);
    expect(response.body).toEqual({ token: "abc" });
    expect(open).toHaveBeenCalledWith({
      hostId: 1,
      address: "127.0.0.1",
      port: 5900,
      password: "s3cret",
    });
  });

  it("offers a way out for a SPICE VM", async () => {
    const { request, replies } = await start({
      services: {
        "remote-desktop.console": { open: async () => ({ token: "x" }) },
      },
    });
    replies.push(
      domainReply(
        `<domain><devices><graphics type='spice' port='5900'/></devices></domain>`,
      ),
    );
    const response = await request("POST", `/hosts/1/vms/${UUID}/console`);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("spice");
  });

  it("needs the console permission", async () => {
    const { request } = await start({
      permissions: ["virtual-machines.use"],
    });
    const response = await request("POST", `/hosts/1/vms/${UUID}/console`);
    expect(response.status).toBe(403);
  });
});
