import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identify, isShadeType, LutronBridge, parseShades } from "../dist/bridge.js";
import { BRIDGE_HOST, BRIDGE_ID, CREDENTIALS, DEVICES, FakeBridge, FAST_TIMING, settle, until } from "./fakes.mjs";

function createBridge(fake = new FakeBridge(), timing = {}) {
  const logs = { debug: [], info: [], warn: [] };
  const events = { shades: [], levels: [], online: [] };
  const bridge = new LutronBridge({ id: BRIDGE_ID, host: BRIDGE_HOST, ...CREDENTIALS }, {
    debug: (message) => logs.debug.push(message),
    info: (message) => logs.info.push(message),
    warn: (message) => logs.warn.push(message)
  }, {
    shades: (shades) => events.shades.push(shades),
    level: (zone, level) => events.levels.push([zone, level]),
    online: (online) => events.online.push(online)
  }, fake.connect, { ...FAST_TIMING, ...timing });
  return { bridge, events, fake, logs };
}

describe("LutronBridge", () => {
  it("connects, reports shades, and applies the current levels", async () => {
    const { bridge, events, fake, logs } = createBridge();
    bridge.start();
    bridge.start();
    await until(() => bridge.isOnline);

    assert.equal(fake.sockets.length, 1);
    assert.equal(fake.options[0].rejectUnauthorized, true);
    assert.deepEqual(events.shades[0].map((shade) => [shade.name, shade.zone, shade.serial]), [
      ["Living Room Shade 2", "/zone/1", "79430373"],
      ["Master Bedroom Shade 1", "/zone/3", "70492003"]
    ]);
    assert.deepEqual(events.levels, [["/zone/1", 100], ["/zone/3", 0], ["/zone/20", 50]]);
    assert.deepEqual(events.online, [true]);
    assert.deepEqual(logs.info, [`Connected to bridge ${BRIDGE_ID} at ${BRIDGE_HOST} with 2 shade(s).`]);
    assert.equal(bridge.id, BRIDGE_ID);
    bridge.stop();
    await until(() => fake.open.length === 0);
    assert.deepEqual(events.online, [true, false]);
  });

  it("follows live level changes from subscriptions and untagged updates", async () => {
    const { bridge, events, fake } = createBridge();
    bridge.start();
    await until(() => bridge.isOnline);
    events.levels.length = 0;

    fake.setLevel("/zone/3", 62.6);
    await until(() => events.levels.length === 2);
    assert.deepEqual(events.levels, [["/zone/3", 63], ["/zone/3", 63]]);

    fake.open[0].send({ Header: { Url: "/zone/9/status/level" }, Body: { ZoneStatus: { Level: "high", Zone: { href: "/zone/9" } } } });
    fake.open[0].send({ Header: { Url: "/zone/9/status/level" }, Body: { ZoneStatuses: [null, { Level: 140, Zone: { href: "/zone/9" } }] } });
    await until(() => events.levels.length === 3);
    assert.deepEqual(events.levels.at(-1), ["/zone/9", 100]);
    bridge.stop();
  });

  it("sends GoToLevel commands and refuses them while offline", async () => {
    const { bridge, fake } = createBridge();
    await assert.rejects(bridge.setLevel("/zone/1", 40), { message: `bridge ${BRIDGE_ID} is offline` });
    bridge.start();
    await until(() => bridge.isOnline);

    await bridge.setLevel("/zone/1", 40.4);
    await bridge.setLevel("/zone/3", 140);
    const commands = fake.requests.filter((request) => request.message.CommuniqueType === "CreateRequest").map((request) => request.message);
    assert.deepEqual(commands.map((command) => [command.Header.Url, command.Body]), [
      ["/zone/1/commandprocessor", { Command: { CommandType: "GoToLevel", Parameter: [{ Type: "Level", Value: 40 }] } }],
      ["/zone/3/commandprocessor", { Command: { CommandType: "GoToLevel", Parameter: [{ Type: "Level", Value: 100 }] } }]
    ]);
    fake.failures.set("/zone/1/commandprocessor", "400 BadRequest");
    await assert.rejects(bridge.setLevel("/zone/1", 10), { status: 400 });
    assert.equal(bridge.isOnline, true);
    bridge.stop();
  });

  it("reconnects with backoff after the bridge goes away", async () => {
    const fake = new FakeBridge();
    fake.refuse = 3;
    const { bridge, events, logs } = createBridge(fake);
    bridge.start();
    await until(() => bridge.isOnline);

    assert.equal(fake.sockets.length, 4);
    assert.equal(logs.warn.filter((message) => message.includes("ECONNREFUSED")).length, 3);
    assert.deepEqual(logs.debug, [1, 2, 4].map((delay) => `Reconnecting to bridge ${BRIDGE_ID} in ${delay} ms.`));

    fake.drop();
    await until(() => events.online.length === 3);
    assert.deepEqual(events.online, [true, false, true]);
    assert.ok(logs.warn.includes(`Lost connection to bridge ${BRIDGE_ID}: connection closed`));
    assert.equal(events.shades.length, 2);
    bridge.stop();
  });

  it("caps the reconnect delay", async () => {
    const fake = new FakeBridge();
    fake.refuse = 6;
    const { bridge, logs } = createBridge(fake);
    bridge.start();
    await until(() => bridge.isOnline);

    assert.deepEqual(logs.debug.map((message) => Number(/in (\d+) ms/u.exec(message)[1])), [1, 2, 4, 8, 8, 8]);
    bridge.stop();
  });

  it("retries when the bridge rejects a request during setup", async () => {
    const fake = new FakeBridge();
    fake.failures.set("/device", "401 Unauthorized");
    const { bridge, logs } = createBridge(fake);
    bridge.start();
    await until(() => fake.sockets.length === 2);
    fake.failures.clear();
    await until(() => bridge.isOnline);

    assert.ok(logs.warn[0].endsWith("/device failed: 401 Unauthorized: Nope"));
    bridge.stop();
  });

  it("drops the connection when pings stop being answered", async () => {
    const fake = new FakeBridge();
    const { bridge, events, logs } = createBridge(fake, { pingIntervalMs: 5, requestTimeoutMs: 20 });
    bridge.start();
    await until(() => bridge.isOnline);
    const pings = () => fake.requests.filter((request) => request.message.Header.Url === "/server/1/status/ping").length;
    await until(() => pings() >= 2);

    fake.silent.add("/server/1/status/ping");
    await until(() => events.online.includes(false));
    assert.ok(logs.warn.some((message) => message === `Bridge ${BRIDGE_ID} stopped answering: /server/1/status/ping timed out`));
    fake.silent.clear();
    await until(() => events.online.length === 3);
    bridge.stop();
  });

  it("moves to a new address", async () => {
    const fake = new FakeBridge();
    fake.refuse = 1;
    const { bridge, logs } = createBridge(fake, { reconnectMinMs: 60000, reconnectMaxMs: 60000 });
    bridge.start();
    await until(() => fake.sockets.length === 1 && logs.debug.length === 1);

    bridge.setHost(BRIDGE_HOST);
    bridge.setHost("192.168.1.50");
    await until(() => bridge.isOnline);
    assert.equal(fake.options[1].host, "192.168.1.50");
    assert.equal(bridge.currentHost, "192.168.1.50");
    assert.ok(logs.info.includes(`Bridge ${BRIDGE_ID} moved from ${BRIDGE_HOST} to 192.168.1.50.`));

    bridge.setHost("192.168.1.51");
    await settle();
    assert.equal(fake.sockets.length, 2);
    bridge.stop();
  });

  it("restarts a connection attempt that is still in progress when the address changes", async () => {
    const fake = new FakeBridge();
    fake.silent.add("/device");
    const { bridge } = createBridge(fake, { requestTimeoutMs: 60000 });
    bridge.start();
    await until(() => fake.requests.length === 1);

    fake.silent.clear();
    bridge.setHost("192.168.1.50");
    await until(() => bridge.isOnline);
    assert.equal(fake.options.at(-1).host, "192.168.1.50");
    bridge.stop();
  });

  it("stays stopped", async () => {
    const fake = new FakeBridge();
    fake.silent.add("/device");
    const { bridge, events } = createBridge(fake);
    bridge.start();
    await until(() => fake.requests.length === 1);
    bridge.stop();
    await settle();

    assert.equal(fake.sockets.length, 1);
    assert.equal(fake.open.length, 0);
    assert.deepEqual(events.shades, []);
    bridge.setHost("192.168.1.50");
    await settle();
    assert.equal(fake.sockets.length, 1);
  });
});

describe("identify", () => {
  it("reads the bridge serial as the mDNS id", async () => {
    const fake = new FakeBridge();
    assert.equal(await identify(BRIDGE_HOST, CREDENTIALS, fake.connect), BRIDGE_ID);
    assert.equal(fake.options[0].port, 8081);
    await until(() => fake.open.length === 0);

    fake.devices = fake.devices.filter((device) => !device.IsThisDevice);
    await assert.rejects(identify(BRIDGE_HOST, CREDENTIALS, fake.connect), { message: `bridge at ${BRIDGE_HOST} did not report its serial number` });
  });
});

describe("parseShades", () => {
  it("keeps addressed shades and names them by area", () => {
    const devices = [
      ...DEVICES,
      { DeviceType: "RollerShade", Name: "Solo", LocalZones: [{ href: "/zone/30" }], SerialNumber: "AB" },
      { DeviceType: "HoneycombShade", LocalZones: [{ href: "/zone/31" }], AddressedState: "Unaddressed" },
      { DeviceType: "Drapery", FullyQualifiedName: [" ", 7], LocalZones: [{ href: "/zone/32" }] },
      { DeviceType: "RollerShade", LocalZones: [] },
      null
    ];

    assert.deepEqual(parseShades({ Devices: devices }).map((shade) => [shade.name, shade.zone, shade.serial, shade.model]), [
      ["Living Room Shade 2", "/zone/1", "79430373", "QSFRJ-S2A13-XX"],
      ["Master Bedroom Shade 1", "/zone/3", "70492003", "QSFRJ-S2A13-XX"],
      ["Solo", "/zone/30", "AB", "RollerShade"],
      ["Shade", "/zone/32", "/zone/32", "Drapery"]
    ]);
    assert.deepEqual(parseShades(undefined), []);
    assert.deepEqual(parseShades({ Devices: "nope" }), []);
  });

  it("recognizes shade device types", () => {
    for (const type of ["TriathlonRollerShade", "SerenaRollerShade", "QsWirelessShade", "Drapery", "TriathlonHoneycombShade"]) {
      assert.equal(isShadeType(type), true, type);
    }

    for (const type of ["SerenaTiltOnlyWoodBlind", "Pico3ButtonRaiseLower", "SmartBridge", "WallDimmer", "TiltShade"]) {
      assert.equal(isShadeType(type), false, type);
    }
  });
});
