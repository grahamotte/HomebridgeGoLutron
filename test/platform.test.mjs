import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRIDGE_HOST, BRIDGE_ID, createPlatform, FakeBridge, FakePlatformAccessory, settle, until } from "./fakes.mjs";

const LIVING = `uuid:homebridge-go-lutron:${BRIDGE_ID}:79430373`;
const MASTER = `uuid:homebridge-go-lutron:${BRIDGE_ID}:70492003`;


describe("GoLutronPlatform", () => {
  it("registers each shade from a paired bridge", async () => {
    const { api, discoveries, fake, messages } = createPlatform();
    api.emit("didFinishLaunching");
    await until(() => api.registered.length === 2);

    assert.deepEqual(discoveries, [5000]);
    assert.deepEqual(api.registered.map((accessory) => [accessory.displayName, accessory.UUID, accessory.context.bridge]), [
      ["Living Room Shade 2", LIVING, BRIDGE_ID],
      ["Master Bedroom Shade 1", MASTER, BRIDGE_ID]
    ]);
    assert.equal(api.registered[0].context.shade.zone, "/zone/1");
    assert.equal(api.registered[0].getService("WindowCovering").getCharacteristic({ name: "CurrentPosition" }).value, 100);
    assert.deepEqual(messages.info.slice(0, 2), ["Adding shade Living Room Shade 2.", "Adding shade Master Bedroom Shade 1."]);
    assert.equal(fake.options[0].host, BRIDGE_HOST);
    api.emit("shutdown");
    await until(() => fake.open.length === 0);
  });

  it("keeps cached shades usable while the bridge is offline", async () => {
    const fake = new FakeBridge();
    fake.refuse = Infinity;
    const { api, messages, platform } = createPlatform({ fake, discovered: [] });
    const cached = new FakePlatformAccessory("Living Room Shade 2", LIVING);
    cached.context = { bridge: BRIDGE_ID, shade: { serial: "79430373", zone: "/zone/1", name: "Living Room Shade 2", model: "QSFRJ-S2A13-XX", type: "TriathlonRollerShade" } };
    const other = new FakePlatformAccessory("Other", "uuid:other");
    other.context = { bridge: "0A" };
    platform.configureAccessory(cached);
    platform.configureAccessory(other);
    await platform.refresh();
    await until(() => fake.sockets.length > 2);

    const covering = cached.getService("WindowCovering");
    assert.equal(cached.getService("AccessoryInformation").getCharacteristic({ name: "Manufacturer" }).value, "Lutron");
    covering.getCharacteristic({ name: "TargetPosition" }).setHandler(30);
    await until(() => messages.warn.some((message) => message.includes("move to 30% failed")));
    assert.deepEqual(api.unregistered, []);
    assert.deepEqual(api.registered, []);
    platform.stop();
  });

  it("restores cached shades and removes ones the bridge no longer reports", async () => {
    const { api, messages, platform } = createPlatform();
    const living = new FakePlatformAccessory("Old Name", LIVING);
    const gone = new FakePlatformAccessory("Gone", `uuid:homebridge-go-lutron:${BRIDGE_ID}:1`);
    gone.context = { bridge: BRIDGE_ID };
    const foreign = new FakePlatformAccessory("Foreign", "uuid:foreign");
    foreign.context = { bridge: "0A" };
    for (const accessory of [living, gone, foreign]) {
      platform.configureAccessory(accessory);
    }

    platform.start();
    await until(() => api.registered.length === 1);
    assert.deepEqual(api.registered.map((accessory) => accessory.UUID), [MASTER]);
    assert.deepEqual(api.updated, [living]);
    assert.deepEqual(api.unregistered, [gone]);
    assert.ok(messages.warn.includes("Removing shade Gone; the bridge no longer reports it."));
    assert.equal(living.getService("AccessoryInformation").getCharacteristic({ name: "Name" }).value, "Living Room Shade 2");
    platform.stop();
  });

  it("pairs a newly discovered bridge after the button is pressed", async () => {
    const { api, fake, messages, platform, store } = createPlatform({ paired: false });
    platform.start();
    await until(() => fake.open.some((socket) => socket.options.port === 8083));
    assert.ok(messages.warn.includes(`Found an unpaired Lutron bridge at ${BRIDGE_HOST}. Press the small black button on the back of the bridge to pair.`));

    fake.pressButton();
    await until(() => api.registered.length === 2);
    const [record] = store.list();
    assert.deepEqual([record.id, record.host, record.ca, record.cert], [BRIDGE_ID, BRIDGE_HOST, "BRIDGE ROOT", "SIGNED CERT"]);
    assert.match(record.key, /BEGIN PRIVATE KEY/u);
    assert.ok(messages.info.includes(`Paired with bridge ${BRIDGE_ID} at ${BRIDGE_HOST}.`));
    assert.equal(fake.options.at(-1).cert, "SIGNED CERT");
    platform.stop();
  });

  it("retries pairing on the next discovery when nobody presses the button", async () => {
    const { fake, messages, platform } = createPlatform({ paired: false, pairingTimeoutMs: 10 });
    await platform.refresh();
    assert.ok(messages.warn.includes(`Pairing with the bridge at ${BRIDGE_HOST} failed: the bridge button was not pressed in time. Will retry.`));

    await platform.refresh();
    assert.equal(fake.sockets.filter((socket) => socket.options.port === 8083).length, 2);
    platform.stop();
  });

  it("follows a bridge that changed address", async () => {
    const { api, fake, platform, store } = createPlatform({ discovered: [{ id: BRIDGE_ID, host: "192.168.1.77" }] });
    platform.start();
    await until(() => api.registered.length === 2);

    assert.equal(fake.options[0].host, "192.168.1.77");
    assert.equal(store.list()[0].host, "192.168.1.77");
    platform.stop();
  });

  it("updates the address of a bridge that is already connected", async () => {
    let host = BRIDGE_HOST;
    const { api, fake, messages, platform } = createPlatform({ discovered: () => [{ id: BRIDGE_ID, host }] });
    platform.start();
    await until(() => api.registered.length === 2);

    host = "192.168.1.78";
    await platform.refresh();
    assert.ok(messages.info.includes(`Bridge ${BRIDGE_ID} moved from ${BRIDGE_HOST} to 192.168.1.78.`));
    assert.equal(fake.sockets.length, 1);
    platform.stop();
  });

  it("uses a configured host instead of mDNS", async () => {
    const { api, discoveries, fake, platform } = createPlatform({ config: { host: " 192.168.1.80 " } });
    platform.start();
    await until(() => api.registered.length === 2);

    assert.deepEqual(discoveries, []);
    assert.equal(fake.options[0].host, "192.168.1.80");
    platform.stop();
  });

  it("pairs a configured host that has no saved credentials", async () => {
    const { fake, platform } = createPlatform({ config: { host: "lutron.lan" }, paired: false });
    platform.start();
    await until(() => fake.open.some((socket) => socket.options.port === 8083));

    assert.equal(fake.options[0].host, "lutron.lan");
    platform.stop();
  });

  it("logs bad hosts, failed discovery, and missing bridges once", async () => {
    const { messages, platform } = createPlatform({ config: { host: "bad host!" }, discovered: new Error("no multicast"), paired: false });
    await platform.refresh();
    await platform.refresh();

    assert.deepEqual(messages.error, ["Ignoring invalid host \"bad host!\"."]);
    assert.deepEqual(messages.warn, [
      "mDNS discovery failed: no multicast",
      "No Lutron bridge found. Set host if mDNS is blocked on this network.",
      "mDNS discovery failed: no multicast"
    ]);
    platform.stop();
  });

  it("does nothing after shutdown", async () => {
    const { api, discoveries, fake, platform } = createPlatform();
    api.emit("shutdown");
    await platform.refresh();
    await settle();

    assert.deepEqual(discoveries, [5000]);
    assert.equal(fake.sockets.length, 0);
  });

  it("reports unexpected discovery errors", async () => {
    const { messages, platform } = createPlatform();
    platform.store.list = () => {
      throw new Error("disk gone");
    };
    await platform.refresh();

    assert.deepEqual(messages.error, ["Bridge discovery failed: disk gone"]);
    platform.stop();
  });
});
