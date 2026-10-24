import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlatform, until } from "./fakes.mjs";

async function createShade() {
  const context = createPlatform();
  context.platform.start();
  await until(() => context.api.registered.length === 3);
  const accessory = context.api.registered[0];
  const covering = accessory.getService("WindowCovering");
  const characteristic = (name) => covering.getCharacteristic({ name });
  return { ...context, accessory, characteristic };
}

describe("ShadeAccessory", () => {
  it("publishes accessory information and the bridge's level", async () => {
    const { accessory, characteristic, platform } = await createShade();
    const info = accessory.getService("AccessoryInformation");

    assert.equal(info.getCharacteristic({ name: "Manufacturer" }).value, "Lutron");
    assert.equal(info.getCharacteristic({ name: "Model" }).value, "QSFRJ-S2A13-XX");
    assert.equal(info.getCharacteristic({ name: "SerialNumber" }).value, "79430373");
    assert.equal(info.getCharacteristic({ name: "Name" }).value, "Living Room Shade 2");
    assert.equal(characteristic("Name").value, "Living Room Shade 2");
    assert.equal(characteristic("CurrentPosition").getHandler(), 100);
    assert.equal(characteristic("TargetPosition").getHandler(), 100);
    assert.equal(characteristic("PositionState").getHandler(), 2);
    platform.stop();
  });

  it("moves the shade from HomeKit and follows the bridge", async () => {
    const { characteristic, fake, messages, platform } = await createShade();

    characteristic("TargetPosition").setHandler(25);
    assert.equal(characteristic("TargetPosition").getHandler(), 25);
    assert.equal(characteristic("PositionState").value, 0);
    assert.equal(characteristic("PositionState").getHandler(), 0);
    await until(() => characteristic("CurrentPosition").value === 25);
    assert.equal(fake.levels.get("/zone/1"), 25);
    assert.equal(characteristic("PositionState").value, 2);

    characteristic("TargetPosition").setHandler(80);
    assert.equal(characteristic("PositionState").value, 1);
    await until(() => characteristic("CurrentPosition").value === 80);
    characteristic("TargetPosition").setHandler("nope");
    assert.equal(characteristic("TargetPosition").getHandler(), 80);
    assert.ok(messages.info.includes("Living Room Shade 2: moving to 25%"));
    platform.stop();
  });

  it("follows changes made at the bridge or a Pico", async () => {
    const { characteristic, fake, platform } = await createShade();

    fake.setLevel("/zone/1", 40);
    await until(() => characteristic("CurrentPosition").value === 40);
    assert.equal(characteristic("TargetPosition").value, 40);
    assert.equal(characteristic("PositionState").value, 2);
    platform.stop();
  });

  it("restores the target when a move fails", async () => {
    const { characteristic, fake, messages, platform } = await createShade();
    fake.failures.set("/zone/1/commandprocessor", "400 BadRequest");

    characteristic("TargetPosition").setHandler(10);
    await until(() => messages.warn.length === 1);
    assert.equal(messages.warn[0], "Living Room Shade 2: move to 10% failed: /zone/1/commandprocessor failed: 400 BadRequest: Nope");
    assert.equal(characteristic("TargetPosition").value, 100);
    assert.equal(characteristic("TargetPosition").getHandler(), 100);
    assert.equal(characteristic("PositionState").value, 2);
    platform.stop();
  });

  it("keeps a newer target when an older move fails", async () => {
    const { characteristic, fake, messages, platform } = await createShade();
    fake.silent.add("/zone/1/commandprocessor");

    characteristic("TargetPosition").setHandler(10);
    fake.silent.clear();
    characteristic("TargetPosition").setHandler(20);
    await until(() => characteristic("CurrentPosition").value === 20);
    fake.drop();
    await until(() => messages.warn.some((message) => message.includes("move to 10% failed")));
    assert.equal(characteristic("TargetPosition").getHandler(), 20);
    platform.stop();
  });
});
