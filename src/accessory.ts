import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import type { LutronBridge, Shade } from "./bridge.js";
import { describe } from "./leap.js";
import type { GoLutronPlatform } from "./platform.js";

export class ShadeAccessory {
  private readonly covering: Service;
  private current?: number;
  private target?: number;

  constructor(
    private readonly platform: GoLutronPlatform,
    private readonly accessory: PlatformAccessory,
    private shade: Shade,
    private bridge: LutronBridge,
  ) {
    const { Service } = platform;
    this.covering = accessory.getService(Service.WindowCovering) ?? accessory.addService(Service.WindowCovering);
    this.setInfo();
    this.bind();
  }

  get zone(): string {
    return this.shade.zone;
  }

  update(shade: Shade, bridge: LutronBridge): void {
    this.shade = shade;
    this.bridge = bridge;
    this.setInfo();
  }

  setLevel(level: number): void {
    const { Characteristic } = this.platform;
    this.current = level;
    this.target = level;
    this.covering.getCharacteristic(Characteristic.CurrentPosition).updateValue(level);
    this.covering.getCharacteristic(Characteristic.TargetPosition).updateValue(level);
    this.covering.getCharacteristic(Characteristic.PositionState).updateValue(Characteristic.PositionState.STOPPED);
  }

  private setInfo(): void {
    const { Characteristic, Service } = this.platform;
    this.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, "Lutron")
      .setCharacteristic(Characteristic.Model, this.shade.model)
      .setCharacteristic(Characteristic.SerialNumber, this.shade.serial)
      .setCharacteristic(Characteristic.Name, this.shade.name);
    this.covering.setCharacteristic(Characteristic.Name, this.shade.name);
  }

  private bind(): void {
    const { Characteristic } = this.platform;
    this.covering.getCharacteristic(Characteristic.CurrentPosition).onGet(() => this.current ?? 0);
    this.covering.getCharacteristic(Characteristic.TargetPosition)
      .onGet(() => this.target ?? this.current ?? 0)
      .onSet((value) => this.setTarget(value));
    this.covering.getCharacteristic(Characteristic.PositionState).onGet(() => this.positionState());
  }

  private setTarget(value: CharacteristicValue): void {
    const { Characteristic } = this.platform;
    const level = Math.min(100, Math.max(0, Math.round(Number(value))));
    if (!Number.isFinite(level)) {
      return;
    }

    this.target = level;
    this.covering.getCharacteristic(Characteristic.PositionState).updateValue(this.positionState());
    this.platform.log.info(`${this.shade.name}: moving to ${level}%`);
    this.bridge.setLevel(this.shade.zone, level).catch((error: unknown) => {
      this.platform.log.warn(`${this.shade.name}: move to ${level}% failed: ${describe(error)}`);
      if (this.target !== level) {
        return;
      }

      this.target = this.current;
      if (this.current !== undefined) {
        this.covering.getCharacteristic(Characteristic.TargetPosition).updateValue(this.current);
      }

      this.covering.getCharacteristic(Characteristic.PositionState).updateValue(Characteristic.PositionState.STOPPED);
    });
  }

  private positionState(): number {
    const { PositionState } = this.platform.Characteristic;
    if (this.target === undefined || this.current === undefined || this.target === this.current) {
      return PositionState.STOPPED;
    }

    return this.target > this.current ? PositionState.INCREASING : PositionState.DECREASING;
  }
}
