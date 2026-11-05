import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { NewVm } from "../../src/shared/types.js";
import {
  cleanupScript,
  cancelScript,
  parsePoll,
  pollScript,
  readLog,
  startScript,
} from "../../src/backend/jobs.js";
import {
  CLOUD_IMAGES,
  createJob,
  createSetup,
  imageFileName,
} from "../../src/backend/libvirt/create.js";
import {
  cloneXml,
  domainXml,
  networkXml,
  spiceToVnc,
} from "../../src/backend/libvirt/domain-xml.js";
import {
  addDiskScript,
  addNicScript,
  defineXmlScript,
  domainIdentity,
  hardwareScript,
  mediaScript,
  nextTarget,
  removeDiskScript,
  removeNicScript,
} from "../../src/backend/libvirt/edit.js";
import { installScript } from "../../src/backend/libvirt/install.js";
import {
  autostartScript,
  cloneJob,
  deleteScript,
  ownedPaths,
  powerScript,
} from "../../src/backend/libvirt/lifecycle.js";
import {
  detailScript,
  inventoryScript,
  leasesScript,
  networksScript,
  snapshotsScript,
  statsScript,
  statusScript,
  volumesScript,
} from "../../src/backend/libvirt/read.js";
import {
  downloadJob,
  networkActionScript,
  networkCreateScript,
  networkDeleteScript,
  poolActionScript,
  poolCreateScript,
  poolDeleteScript,
  snapshotCreateScript,
  snapshotDeleteScript,
  snapshotRevertScript,
  volumeCreateScript,
  volumeDeleteScript,
  volumePathScript,
} from "../../src/backend/libvirt/storage.js";
import { parseCidr } from "../../src/backend/validate.js";

const URI = "qemu:///system";
const UUID = "a0807dfb-b54d-4620-a64a-26762c1df25a";
const EVIL = "x'; touch /tmp/owned; '";

const vm = (overrides: Partial<NewVm> = {}): NewVm => ({
  name: "web-1",
  vcpus: 2,
  memoryMib: 2048,
  diskGib: 20,
  pool: "default",
  firmware: "bios",
  network: { type: "network", source: "default" },
  source: {
    type: "cloud",
    image: "debian-13",
    url: "",
    username: "admin",
    password: "pa'ss$word",
    sshKey: "ssh-ed25519 AAAA me@box",
  },
  autostart: true,
  start: true,
  ...overrides,
});

const disks = [
  {
    device: "disk",
    target: "vda",
    bus: "virtio",
    source: "/images/a.qcow2",
    format: "qcow2",
    readOnly: false,
  },
  {
    device: "cdrom",
    target: "sda",
    bus: "sata",
    source: "/images/a-seed.iso",
    format: "raw",
    readOnly: true,
  },
];

describe("every script parses in bash", () => {
  const ip = parseCidr("192.168.50.1/24");
  const scripts: Record<string, string> = {
    inventory: inventoryScript(URI),
    status: statusScript(URI),
    detail: detailScript(URI, UUID),
    stats: statsScript(URI, UUID),
    snapshots: snapshotsScript(URI, UUID),
    volumes: volumesScript(URI, EVIL),
    networks: networksScript(URI),
    leases: leasesScript(URI, EVIL),
    power: powerScript(URI, UUID, "stop"),
    autostart: autostartScript(URI, UUID, false),
    delete: deleteScript(URI, UUID, EVIL, ["/images/a.qcow2", EVIL]),
    clone: cloneJob(URI, UUID, "b", "<domain/>", disks),
    createCloud: createJob(URI, vm(), ""),
    createIso: createJob(
      URI,
      vm({ source: { type: "iso", volume: "a.iso" } }),
      "/images/a.iso",
    ),
    createBlank: createJob(URI, vm({ source: { type: "blank" } }), ""),
    setup: createSetup(vm()),
    hardware: hardwareScript(URI, UUID, { vcpus: 4, memoryMib: 1024 }),
    addDisk: addDiskScript(URI, UUID, "default", "a.qcow2", 5, "vdb", true),
    removeDisk: removeDiskScript(URI, UUID, "vdb", false),
    media: mediaScript(URI, UUID, "sda", "/a.iso", true),
    mediaNew: mediaScript(URI, UUID, "sda", "/a.iso", false),
    eject: mediaScript(URI, UUID, "sda", "", true),
    addNic: addNicScript(URI, UUID, "network", "default", true),
    removeNic: removeNicScript(URI, UUID, "network", "52:54:00:00:00:01", true),
    define: defineXmlScript(URI, UUID, "<domain/>"),
    snapshot: snapshotCreateScript(URI, UUID, "s1", EVIL),
    revert: snapshotRevertScript(URI, UUID, EVIL),
    deleteSnapshot: snapshotDeleteScript(URI, UUID, EVIL),
    pool: poolCreateScript(URI, "p", "/srv/my vms"),
    poolAction: poolActionScript(URI, EVIL, "noautostart"),
    poolDelete: poolDeleteScript(URI, EVIL),
    volume: volumeCreateScript(URI, EVIL, EVIL, 1),
    volumeDelete: volumeDeleteScript(URI, EVIL, EVIL),
    volumePath: volumePathScript(URI, EVIL, EVIL),
    download: downloadJob(URI, "default", "a.iso", "https://x.test/a?b=c&d"),
    network: networkCreateScript(URI, "n", { type: "nat", ip }),
    networkAction: networkActionScript(URI, EVIL, "stop"),
    networkDelete: networkDeleteScript(URI, EVIL),
    jobStart: startScript("abc", {
      setup: createSetup(vm()),
      body: "echo hi",
      label: "x",
      vmName: "x",
    }),
    jobPoll: pollScript(["abc", "def"]),
    jobCancel: cancelScript("abc"),
    jobClean: cleanupScript(["abc"]),
    install: installScript("apt-get"),
  };

  for (const [name, script] of Object.entries(scripts)) {
    it(name, () => {
      const result = spawnSync("bash", ["-n"], {
        input: script,
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  }
});

describe("scripts quote what they are given", () => {
  it("keeps a hostile name in one argument", () => {
    expect(snapshotDeleteScript(URI, UUID, EVIL)).toContain(
      `'x'\\''; touch /tmp/owned; '\\'''`,
    );
  });

  it("does not put an empty description on the command line", () => {
    expect(snapshotCreateScript(URI, UUID, "s1", "")).not.toContain(
      "--description",
    );
  });
});

describe("secrets", () => {
  it("keeps the plain password out of the detached job", () => {
    const body = createJob(URI, vm(), "");
    expect(body).not.toContain("pa'ss$word");
    expect(body).not.toContain(Buffer.from("pa'ss$word").toString("base64"));
    const setup = createSetup(vm());
    expect(setup).toContain("openssl passwd -6");
    expect(setup).not.toContain("pa'ss$word");
  });

  it("writes the hash in cloud-init, never the password", () => {
    const userData = Buffer.from(
      /printf '%s' '([^']+)' \| base64 -d > user-data/.exec(
        createSetup(vm()),
      )?.[1] ?? "",
      "base64",
    ).toString();
    expect(userData).toContain("passwd: __TERMIX_HASH__");
    expect(userData).toContain("ssh_pwauth: true");
    expect(userData).toContain('"ssh-ed25519 AAAA me@box"');
  });

  it("locks the login when there is only a key", () => {
    const setup = createSetup(
      vm({
        source: {
          type: "cloud",
          image: "debian-13",
          url: "",
          username: "admin",
          password: "",
          sshKey: "ssh-ed25519 AAAA",
        },
      }),
    );
    expect(setup).not.toContain("openssl");
    const encoded = /'([^']+)' \| base64 -d > user-data/.exec(setup)?.[1];
    expect(Buffer.from(encoded ?? "", "base64").toString()).toContain(
      "lock_passwd: true",
    );
  });
});

describe("images", () => {
  it("reads the image's own format, not a child node's", () => {
    const script = createJob(URI, vm(), "");
    expect(script).toContain("sed -n 's/^file format: //p'");
    expect(script).not.toContain("--output=json");
  });

  it("names a cached image by its URL", () => {
    expect(imageFileName("https://a/b.img")).toBe(
      imageFileName("https://a/b.img"),
    );
    expect(imageFileName("https://a/b.img")).not.toBe(
      imageFileName("https://a/c.img"),
    );
  });

  it("has https images with unique ids", () => {
    const ids = CLOUD_IMAGES.map((image) => image.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const image of CLOUD_IMAGES) {
      expect(image.url.startsWith("https://")).toBe(true);
    }
  });
});

describe("domain xml", () => {
  it("escapes names and binds VNC to loopback", () => {
    const xml = domainXml(vm({ name: "a&b" }), {
      disk: "/images/a.qcow2",
      cdroms: ["/images/seed.iso"],
    });
    expect(xml).toContain("<name>a&amp;b</name>");
    expect(xml).toContain("listen='127.0.0.1'");
    expect(xml).toContain("<target dev='sda' bus='sata'/>");
    expect(xml).toContain("<serial type='pty'/>");
  });

  it("turns on UEFI and boots an ISO after the disk", () => {
    const xml = domainXml(
      vm({ firmware: "uefi", source: { type: "iso", volume: "a.iso" } }),
      { disk: "/a", cdroms: ["/b"] },
    );
    expect(xml).toContain("<os firmware='efi'>");
    expect(xml).toContain("<boot dev='hd'/><boot dev='cdrom'/>");
    expect(xml).toContain("<acpi/>");
  });

  it("builds networks", () => {
    const ip = parseCidr("192.168.50.1/24");
    expect(networkXml("n", { type: "nat", ip })).toContain(
      "<forward mode='nat'/>",
    );
    expect(networkXml("n", { type: "isolated", ip })).not.toContain("forward");
    expect(networkXml("n", { type: "bridge", bridge: "br0" })).toContain(
      "<bridge name='br0'/>",
    );
  });

  it("clones without ids and with new disks", () => {
    const xml = cloneXml(
      `<domain><name>a</name><uuid>u</uuid><os><nvram template='x'>/n</nvram></os>
<disk><source file='/images/a.qcow2'/></disk><interface><mac address='52:54:00:00:00:01'/></interface></domain>`,
      "b",
      new Map([["/images/a.qcow2", "/images/b-vda.qcow2"]]),
    );
    expect(xml).toContain("<name>b</name>");
    expect(xml).not.toContain("<uuid>");
    expect(xml).not.toContain("<mac");
    expect(xml).not.toContain("<nvram");
    expect(xml).toContain("file='/images/b-vda.qcow2'");
  });

  it("swaps SPICE for VNC and drops what needs SPICE", () => {
    const xml = spiceToVnc(`<devices>
      <graphics type='spice' autoport='yes'><listen type='address'/></graphics>
      <channel type='spicevmc'><target type='virtio'/></channel>
      <redirdev bus='usb' type='spicevmc'><address/></redirdev>
      <audio id='1' type='spice'/>
      <channel type='unix'><target name='agent'/></channel>
    </devices>`);
    expect(xml).toContain("<graphics type='vnc'");
    expect(xml).not.toContain("spice");
    expect(xml).toContain("name='agent'");
  });

  it("reads a domain's identity and refuses junk", () => {
    expect(
      domainIdentity("<domain><name>a</name><uuid>ABC</uuid></domain>"),
    ).toEqual({ name: "a", uuid: "abc" });
    expect(() => domainIdentity("<network/>")).toThrow();
  });
});

describe("disks", () => {
  it("picks the next free target", () => {
    expect(nextTarget(disks, "vd")).toBe("vdb");
    expect(nextTarget(disks, "sd")).toBe("sdb");
  });

  it("removes its own disks and seed, not another ISO", () => {
    expect(
      ownedPaths(
        [
          ...disks,
          { ...disks[1], target: "sdb", source: "/images/installer.iso" },
          { ...disks[0], target: "vdb", source: "pool/rbd" },
        ],
        "a",
      ),
    ).toEqual(["/images/a.qcow2", "/images/a-seed.iso"]);
  });
});

describe("jobs", () => {
  it("reads a poll", () => {
    const polled = parsePoll(
      "@@run=a\n@@alive\n@@log\nhello\n\n@@run=b\n@@result=3\n@@log\n\n@@run=c\n@@missing\n@@end\n",
    );
    expect(polled.get("a")).toMatchObject({ alive: true, result: null });
    expect(polled.get("a")?.log).toContain("hello");
    expect(polled.get("b")).toMatchObject({ alive: false, result: 3 });
    expect(polled.get("c")?.missing).toBe(true);
  });

  it("counts exit code 0 as a result", () => {
    expect(
      parsePoll("@@run=a\n@@result=0\n@@log\n@@end\n").get("a")?.result,
    ).toBe(0);
  });

  it("reads curl and qemu-img progress out of the log", () => {
    const curl = readLog("@@phase download\n###   12.5%\n######    40.0%\n");
    expect(curl).toMatchObject({ phase: "download", percent: 40, lines: [] });
    expect(readLog("@@phase clone\n    (55.03/100%)\n").percent).toBe(55.03);
    expect(
      readLog("@@phase download\n50.0%\n@@phase disk\n").percent,
    ).toBeNull();
  });

  it("keeps the phase when the log tail has lost it", () => {
    expect(pollScript(["a"])).toContain("grep -a '^@@phase '");
    const polled = parsePoll(
      "@@run=a\n@@alive\n@@log\n@@phase download\n##  20.0%\n@@end\n",
    ).get("a");
    expect(readLog(polled?.log ?? "")).toMatchObject({
      phase: "download",
      percent: 20,
    });
  });

  it("keeps real lines for the error", () => {
    const { lines } = readLog(
      "@@phase define\nerror: Failed to define domain\n",
    );
    expect(lines).toContain("error: Failed to define domain");
  });
});
