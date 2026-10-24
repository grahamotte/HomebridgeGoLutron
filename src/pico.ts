import type { PlatformAccessory, Service } from "homebridge";
import type { Pico } from "./bridge.js";
import type { GoLutronPlatform } from "./platform.js";
import { PressDetector, type Press, type PressTiming } from "./press.js";

interface Button {
  readonly service: Service;
  readonly detector: PressDetector;
  name: string;
}

export class PicoAccessory {
  private readonly buttons = new Map<string, Button>();

  constructor(
    private readonly platform: GoLutronPlatform,
    private readonly accessory: PlatformAccessory,
    private pico: Pico,
    private readonly timing: PressTiming,
  ) {
    this.update(pico);
  }

  has(button: string): boolean {
    return this.buttons.has(button);
  }

  update(pico: Pico): void {
    const { Characteristic, Service } = this.platform;
    this.pico = pico;
    this.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, "Lutron")
      .setCharacteristic(Characteristic.Model, pico.model)
      .setCharacteristic(Characteristic.SerialNumber, pico.serial)
      .setCharacteristic(Characteristic.Name, pico.name);
    const label = this.accessory.getService(Service.ServiceLabel) ?? this.accessory.addService(Service.ServiceLabel);
    label.setCharacteristic(Characteristic.ServiceLabelNamespace, Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);

    const current = new Set(pico.buttons.map(({ button }) => button));
    for (const service of this.accessory.services) {
      if (service.UUID === Service.StatelessProgrammableSwitch.UUID && !current.has(service.subtype ?? "")) {
        this.accessory.removeService(service);
      }
    }

    for (const [button, { detector }] of this.buttons) {
      if (!current.has(button)) {
        detector.reset();
        this.buttons.delete(button);
      }
    }

    const { ProgrammableSwitchEvent } = Characteristic;
    const presses = [ProgrammableSwitchEvent.SINGLE_PRESS, ...(this.timing.doublePressMs > 0 ? [ProgrammableSwitchEvent.DOUBLE_PRESS] : []), ProgrammableSwitchEvent.LONG_PRESS];
    pico.buttons.forEach(({ button, name }, index) => {
      const service = this.accessory.getServiceById(Service.StatelessProgrammableSwitch, button)
        ?? this.accessory.addService(Service.StatelessProgrammableSwitch, name, button);
      service.setCharacteristic(Characteristic.Name, name);
      service.setCharacteristic(Characteristic.ServiceLabelIndex, index + 1);
      service.getCharacteristic(ProgrammableSwitchEvent).setProps({ validValues: presses }).onGet(() => null);
      const existing = this.buttons.get(button);
      if (existing) {
        existing.name = name;
      } else {
        const entry: Button = { service, name, detector: new PressDetector(this.timing, (press) => this.fire(entry, press)) };
        this.buttons.set(button, entry);
      }
    });
  }

  handle(button: string, event: string): void {
    this.buttons.get(button)?.detector.handle(event);
  }

  reset(): void {
    for (const { detector } of this.buttons.values()) {
      detector.reset();
    }
  }

  private fire(button: Button, press: Press): void {
    const { ProgrammableSwitchEvent } = this.platform.Characteristic;
    const value = press === "long" ? ProgrammableSwitchEvent.LONG_PRESS : press === "double" ? ProgrammableSwitchEvent.DOUBLE_PRESS : ProgrammableSwitchEvent.SINGLE_PRESS;
    this.platform.log.debug(`${this.pico.name} ${button.name}: ${press} press`);
    button.service.getCharacteristic(ProgrammableSwitchEvent).sendEventNotification(value);
  }
}
