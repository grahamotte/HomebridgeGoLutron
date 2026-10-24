import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identify, isPicoType, isShadeType, LutronBridge, parsePicos, parseShades } from "../dist/bridge.js";
import { BRIDGE_HOST, BRIDGE_ID, BUTTONS, CREDENTIALS, DEVICES, FakeBridge, FAST_TIMING, settle, until } from "./fakes.mjs";

function createBridge(fake = new FakeBridge(), timing = {}) {
  const logs = { debug: [], info: [], warn: [] };
  const events = { shades: [], picos: [], levels: [], buttons: [], online: [] };
  const bridge = new LutronBridge({ id: BRIDGE_ID, host: BRIDGE_HOST, ...CREDENTIALS }, {
    debug: (message) => logs.debug.push(message),
    info: (message) => logs.info.push(message),
    warn: (message) => logs.warn.push(message)
  }, {
    devices: (shades, picos) => {
      events.shades.push(shades);
      events.picos.push(picos);
    },
    level: (zone, level) => events.levels.push([zone, level]),
    button: (button, event) => events.buttons.push([button, event]),
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
    assert.deepEqual(logs.info, [`Connected to bridge ${BRIDGE_ID} at ${BRIDGE_HOST} with 2 shade(s) and 1 Pico(s).`]);
    assert.equal(bridge.id, BRIDGE_ID);
    bridge.stop();
    await until(() => fake.open.length === 0);
    assert.deepEqual(events.online, [true, false]);
  });

  it("reports Picos and follows their button events without sending commands", async () => {
    const { bridge, events, fake } = createBridge();
    bridge.start();
    await until(() => bridge.isOnline);

    assert.deepEqual(events.picos[0].map((pico) => [pico.name, pico.serial, pico.device, pico.buttons.map((button) => button.name)]), [
      ["Living Room Pico", "81234567", "/device/12", ["On", "Raise", "Favorite", "Lower", "Off"]]
    ]);
    const subscribed = fake.requests.filter((request) => request.message.CommuniqueType === "SubscribeRequest").map((request) => request.message.Header.Url);
    assert.deepEqual(subscribed.filter((url) => url.startsWith("/button")).sort(), BUTTONS.map((button) => `${button.href}/status/event`).sort());

    fake.buttonEvent("/button/105", "Press");
    fake.buttonEvent("/button/105", "Release");
    fake.open[0].send({ Header: { Url: "/button/102/status/event" }, Body: { ButtonStatus: { Button: { href: "/button/102" }, ButtonEvent: { EventType: "Press" } } } });
    fake.open[0].send({ Header: { Url: "/button/102/status/event" }, Body: { ButtonStatus: { Button: { href: "/button/102" } } } });
    fake.open[0].send({ Header: { Url: "/button/102/status/event" } });
    await until(() => events.buttons.length === 3);
    await settle();
    assert.deepEqual(events.buttons, [["/button/105", "Press"], ["/button/105", "Release"], ["/button/102", "Press"]]);
    assert.equal(fake.requests.filter((request) => !["ReadRequest", "SubscribeRequest"].includes(request.message.CommuniqueType)).length, 0);
    bridge.stop();
  });

  it("subscribes to buttons again after a reconnect", async () => {
    const { bridge, events, fake } = createBridge();
    bridge.start();
    await until(() => bridge.isOnline);
    fake.drop();
    await until(() => events.online.length === 3);

    fake.buttonEvent("/button/104", "Press");
    await until(() => events.buttons.length === 1);
    assert.equal(fake.requests.filter((request) => request.message.Header.Url === "/button/104/status/event").length, 2);
    bridge.stop();
  });

  it("still connects the shades when Pico buttons cannot be read or followed", async () => {
    const fake = new FakeBridge();
    fake.failures.set("/button", "500 InternalServerError");
    const { bridge, events, logs } = createBridge(fake);
    bridge.start();
    await until(() => bridge.isOnline);
    assert.equal(events.shades[0].length, 2);
    assert.deepEqual(events.picos, [undefined]);
    assert.ok(logs.warn.includes(`Bridge ${BRIDGE_ID}: could not read Pico buttons: /button failed: 500 InternalServerError: Nope`));
    bridge.stop();

    const other = new FakeBridge();
    other.failures.set("/button/103/status/event", "400 BadRequest");
    const second = createBridge(other);
    second.bridge.start();
    await until(() => second.bridge.isOnline);
    assert.equal(second.events.picos[0][0].buttons.length, 5);
    assert.ok(second.logs.warn.includes(`Bridge ${BRIDGE_ID}: could not follow Living Room Pico button 1: /button/103/status/event failed: 400 BadRequest: Nope`));
    second.bridge.stop();
  });

  it("treats an empty button list as no Picos and skips it when there are no Picos", async () => {
    const fake = new FakeBridge();
    fake.buttons = undefined;
    const { bridge, events } = createBridge(fake);
    bridge.start();
    await until(() => bridge.isOnline);
    assert.deepEqual(events.picos, [[]]);
    bridge.stop();

    const bare = new FakeBridge();
    bare.devices = bare.devices.filter((device) => !device.DeviceType.startsWith("Pico"));
    const second = createBridge(bare);
    second.bridge.start();
    await until(() => second.bridge.isOnline);
    assert.deepEqual(second.events.picos, [[]]);
    assert.equal(bare.requests.some((request) => request.message.Header.Url === "/button"), false);
    second.bridge.stop();
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

describe("parsePicos", () => {
  it("groups buttons by Pico, labels them by model, and orders them top to bottom", () => {
    const devices = [
      ...DEVICES,
      { DeviceType: "Pico2Button", href: "/device/30", Name: "Solo", ButtonGroups: [{ href: "/buttongroup/9" }] },
      { DeviceType: "Pico4Button2Group", href: "/device/31", SerialNumber: 9, FullyQualifiedName: ["Den", "Remote"], ButtonGroups: [{ href: "/buttongroup/10" }, { href: "/buttongroup/11" }] },
      { DeviceType: "PicoNew", href: "/device/32", SerialNumber: 10, ButtonGroups: [{ href: "/buttongroup/12" }, null, { href: "/buttongroup/99" }] },
      { DeviceType: "Pico3Button", href: "/device/33", ButtonGroups: [{ href: "/buttongroup/13" }], AddressedState: "Unaddressed" },
      { DeviceType: "Pico3Button", href: "/device/34", ButtonGroups: "nope" },
      { DeviceType: "Pico3Button", ButtonGroups: [{ href: "/buttongroup/13" }] },
      null
    ];
    const buttons = [
      ...BUTTONS,
      { href: "/button/301", ButtonNumber: 2, Parent: { href: "/buttongroup/9" } },
      { href: "/button/300", ButtonNumber: 0, Parent: { href: "/buttongroup/9" } },
      { href: "/button/312", ButtonNumber: 4, Parent: { href: "/buttongroup/11" } },
      { href: "/button/311", ButtonNumber: 3, Parent: { href: "/buttongroup/11" } },
      { href: "/button/310", ButtonNumber: 1, Parent: { href: "/buttongroup/10" } },
      { href: "/button/320", ButtonNumber: 7, Parent: { href: "/buttongroup/12" }, Name: " Top " },
      { href: "/button/321", ButtonNumber: 2, Parent: { href: "/buttongroup/12" }, Name: "" },
      { href: "/button/330", ButtonNumber: 1, Parent: { href: "/buttongroup/13" } },
      { href: "/button/399", ButtonNumber: 1.5, Parent: { href: "/buttongroup/12" } },
      { href: "/button/398", Parent: { href: "/buttongroup/12" } },
      { ButtonNumber: 1, Parent: { href: "/buttongroup/12" } },
      { href: "/button/397", ButtonNumber: 1 },
      null
    ];

    assert.deepEqual(parsePicos({ Devices: devices }, { Buttons: buttons }).map((pico) => [pico.name, pico.serial, pico.model, pico.buttons.map((button) => [button.button, button.name])]), [
      ["Living Room Pico", "81234567", "PJ2-3BRL-GXX-X01", [
        ["/button/102", "On"], ["/button/105", "Raise"], ["/button/103", "Favorite"], ["/button/106", "Lower"], ["/button/104", "Off"]
      ]],
      ["Solo", "/device/30", "Pico2Button", [["/button/300", "On"], ["/button/301", "Off"]]],
      ["Den Remote", "9", "Pico4Button2Group", [
        ["/button/310", "Group 1 Button 1"], ["/button/311", "Group 2 Button 1"], ["/button/312", "Group 2 Button 2"]
      ]],
      ["Pico", "10", "PicoNew", [["/button/321", "Button 2"], ["/button/320", "Top"]]]
    ]);
    assert.deepEqual(parsePicos({ Devices: devices }, undefined), []);
    assert.deepEqual(parsePicos(undefined, { Buttons: buttons }), []);
    assert.deepEqual(parsePicos({ Devices: DEVICES }, { Buttons: "nope" }), []);
  });

  it("recognizes Pico device types", () => {
    for (const type of ["Pico2Button", "Pico3ButtonRaiseLower", "Pico4ButtonScene"]) {
      assert.equal(isPicoType(type), true, type);
    }

    for (const type of ["TriathlonRollerShade", "SmartBridge", "WallDimmer"]) {
      assert.equal(isPicoType(type), false, type);
    }
  });
});
