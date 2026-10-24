import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRIDGE_ID, createPlatform, FakeBridge, FakePlatformAccessory, settle, until } from "./fakes.mjs";

const PICO = `uuid:homebridge-go-lutron:${BRIDGE_ID}:81234567`;
const SWITCH = { UUID: "StatelessProgrammableSwitch" };

function switches(accessory) {
  return accessory.services.filter((service) => service.UUID === SWITCH.UUID);
}

function events(accessory, button) {
  return accessory.getServiceById(SWITCH, button).getCharacteristic({ name: "ProgrammableSwitchEvent" }).events;
}

async function createPico(options = {}) {
  const context = createPlatform(options);
  context.platform.start();
  await until(() => context.api.registered.some((accessory) => accessory.UUID === PICO));
  const accessory = context.api.registered.find((candidate) => candidate.UUID === PICO);
  return { ...context, accessory };
}

function cachedPico(buttons = [{ button: "/button/102", number: 0, name: "On" }, { button: "/button/107", number: 9, name: "Gone" }]) {
  const accessory = new FakePlatformAccessory("Living Room Pico", PICO);
  accessory.context = {
    bridge: BRIDGE_ID,
    pico: { serial: "81234567", device: "/device/12", name: "Living Room Pico", model: "PJ2-3BRL-GXX-X01", type: "Pico3ButtonRaiseLower", buttons }
  };
  return accessory;
}

describe("PicoAccessory", () => {
  it("publishes one labelled stateless switch per button in Pico order", async () => {
    const { accessory, platform } = await createPico();
    const info = accessory.getService("AccessoryInformation");

    assert.equal(info.getCharacteristic({ name: "Manufacturer" }).value, "Lutron");
    assert.equal(info.getCharacteristic({ name: "Model" }).value, "PJ2-3BRL-GXX-X01");
    assert.equal(info.getCharacteristic({ name: "SerialNumber" }).value, "81234567");
    assert.equal(info.getCharacteristic({ name: "Name" }).value, "Living Room Pico");
    assert.equal(accessory.getService("ServiceLabel").getCharacteristic({ name: "ServiceLabelNamespace" }).value, 1);
    assert.deepEqual(switches(accessory).map((service) => [
      service.subtype,
      service.getCharacteristic({ name: "Name" }).value,
      service.getCharacteristic({ name: "ServiceLabelIndex" }).value
    ]), [
      ["/button/102", "On", 1],
      ["/button/105", "Raise", 2],
      ["/button/103", "Favorite", 3],
      ["/button/106", "Lower", 4],
      ["/button/104", "Off", 5]
    ]);
    const event = switches(accessory)[0].getCharacteristic({ name: "ProgrammableSwitchEvent" });
    assert.deepEqual(event.props.validValues, [0, 1, 2]);
    assert.equal(event.getHandler(), null);
    platform.stop();
  });

  it("turns button presses into single, double, and long press events", async () => {
    const { accessory, fake, messages, platform } = await createPico();

    fake.buttonEvent("/button/102", "Press");
    fake.buttonEvent("/button/102", "Release");
    await until(() => events(accessory, "/button/102").length === 1);

    fake.buttonEvent("/button/104", "Press");
    fake.buttonEvent("/button/104", "Release");
    fake.buttonEvent("/button/104", "Press");
    fake.buttonEvent("/button/104", "Release");
    await until(() => events(accessory, "/button/104").length === 1);

    fake.buttonEvent("/button/105", "Press");
    await until(() => events(accessory, "/button/105").length === 1);
    fake.buttonEvent("/button/105", "Release");
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.deepEqual(events(accessory, "/button/102"), [0]);
    assert.deepEqual(events(accessory, "/button/104"), [1]);
    assert.deepEqual(events(accessory, "/button/105"), [2]);
    assert.deepEqual(events(accessory, "/button/103"), []);
    assert.ok(messages.debug.includes("Living Room Pico Raise: long press"));
    assert.equal(fake.requests.filter((request) => request.message.CommuniqueType === "CreateRequest").length, 0);
    assert.deepEqual([...fake.levels.values()], [100, 0, 50]);
    platform.stop();
  });

  it("drops a press cut off by a disconnect and follows buttons again after reconnecting", async () => {
    const { accessory, fake, platform } = await createPico();
    const sockets = fake.sockets.length;

    fake.buttonEvent("/button/102", "Press");
    await settle();
    fake.drop();
    await until(() => fake.open.length === 1 && fake.sockets.length > sockets && fake.open[0].buttons.size === 5);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(events(accessory, "/button/102"), []);

    fake.buttonEvent("/button/102", "Press");
    fake.buttonEvent("/button/102", "Release");
    await until(() => events(accessory, "/button/102").length === 1);
    platform.stop();
  });

  it("keeps a cached Pico while the bridge is offline", async () => {
    const fake = new FakeBridge();
    fake.refuse = Infinity;
    const { api, platform } = createPlatform({ fake, discovered: [] });
    const cached = cachedPico();
    platform.configureAccessory(cached);
    await platform.refresh();
    await until(() => fake.sockets.length > 2);

    assert.deepEqual(switches(cached).map((service) => service.subtype), ["/button/102", "/button/107"]);
    assert.deepEqual(api.unregistered, []);
    platform.stop();
  });

  it("keeps a cached Pico when the bridge cannot list its buttons", async () => {
    const fake = new FakeBridge();
    fake.failures.set("/button", "500 InternalServerError");
    const { api, messages, platform } = createPlatform({ fake });
    const cached = cachedPico();
    platform.configureAccessory(cached);
    platform.start();
    await until(() => api.registered.length === 2);

    assert.deepEqual(api.unregistered, []);
    assert.equal(switches(cached).length, 2);
    assert.ok(messages.warn.some((message) => message.includes("could not read Pico buttons")));
    platform.stop();
  });

  it("updates a cached Pico's buttons and removes Picos the bridge no longer reports", async () => {
    const { api, platform } = createPlatform();
    const cached = cachedPico();
    platform.configureAccessory(cached);
    platform.start();
    await until(() => api.registered.length === 2);

    assert.deepEqual(api.updated.filter((accessory) => accessory.UUID === PICO), [cached]);
    assert.deepEqual(switches(cached).map((service) => service.subtype), ["/button/102", "/button/105", "/button/103", "/button/106", "/button/104"]);
    platform.stop();

    const fake = new FakeBridge();
    fake.devices = fake.devices.filter((device) => !device.DeviceType.startsWith("Pico"));
    const gone = createPlatform({ fake });
    gone.platform.configureAccessory(cachedPico());
    gone.platform.start();
    await until(() => gone.api.unregistered.length === 1);
    assert.equal(gone.api.unregistered[0].UUID, PICO);
    assert.ok(gone.messages.warn.includes("Removing Pico Living Room Pico; the bridge no longer reports it."));
    gone.platform.stop();
  });
});
