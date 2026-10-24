import net from "node:net";
import path from "node:path";
import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service
} from "homebridge";
import { ShadeAccessory } from "./accessory.js";
import { identify, LutronBridge, type Pico, type Shade } from "./bridge.js";
import { discoverBridges, type DiscoveredBridge } from "./discovery.js";
import { describe, type SocketFactory } from "./leap.js";
import { pair } from "./pairing.js";
import { PicoAccessory } from "./pico.js";
import type { PressTiming } from "./press.js";
import {
  DEFAULT_PRESS_TIMING,
  DEFAULT_TIMING,
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_TIMEOUT_MS,
  PAIRING_TIMEOUT_MS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  STORAGE_DIRECTORY,
  type BridgeTiming
} from "./settings.js";
import { CredentialStore, type BridgeRecord } from "./store.js";

interface Context {
  bridge?: string;
  shade?: Shade;
  pico?: Pico;
}

export interface PlatformDependencies {
  readonly connect?: SocketFactory;
  readonly discover?: (timeoutMs: number) => Promise<DiscoveredBridge[]>;
  readonly storagePath?: string;
  readonly timing?: Partial<BridgeTiming>;
  readonly pressTiming?: Partial<PressTiming>;
  readonly discoveryIntervalMs?: number;
  readonly pairingTimeoutMs?: number;
}

export class GoLutronPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly store: CredentialStore;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly controllers = new Map<string, ShadeAccessory>();
  private readonly picos = new Map<string, PicoAccessory>();
  private readonly bridges = new Map<string, LutronBridge>();
  private readonly host?: string;
  private readonly timing: BridgeTiming;
  private readonly pressTiming: PressTiming;
  private refreshing?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private reportedMissing = false;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
    private readonly dependencies: PlatformDependencies = {},
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.timing = { ...DEFAULT_TIMING, ...dependencies.timing };
    this.pressTiming = { ...DEFAULT_PRESS_TIMING, ...dependencies.pressTiming };
    this.store = new CredentialStore(path.join(dependencies.storagePath ?? api.user.storagePath(), STORAGE_DIRECTORY));
    const host = typeof config.host === "string" ? config.host.trim() : "";
    if (host && (net.isIP(host) || /^[A-Za-z0-9.-]+$/u.test(host))) {
      this.host = host;
    } else if (host) {
      this.log.error(`Ignoring invalid host ${JSON.stringify(config.host)}.`);
    }

    api.on("didFinishLaunching", () => this.start());
    api.on("shutdown", () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  start(): void {
    this.refresh().catch(() => undefined);
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(() => undefined);
    }, this.dependencies.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    for (const bridge of this.bridges.values()) {
      bridge.stop();
    }

    this.bridges.clear();
    for (const pico of this.picos.values()) {
      pico.reset();
    }
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.findBridges()
      .catch((error: unknown) => {
        this.log.error(`Bridge discovery failed: ${describe(error)}`);
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async findBridges(): Promise<void> {
    const discover = this.dependencies.discover ?? discoverBridges;
    const discovered = this.host ? [] : await discover(DISCOVERY_TIMEOUT_MS).catch((error: unknown) => {
      this.log.warn(`mDNS discovery failed: ${describe(error)}`);
      return [];
    });
    if (this.stopped) {
      return;
    }

    const records = this.store.list();
    const pairings: Promise<void>[] = [];
    for (const bridge of discovered) {
      const record = records.find((candidate) => candidate.id === bridge.id);
      if (record) {
        this.ensureBridge(record.host === bridge.host ? record : this.saveHost(record, bridge.host));
      } else {
        pairings.push(this.pairBridge(bridge.host));
      }
    }

    if (this.host) {
      const record = records.find((candidate) => candidate.host === this.host) ?? (records.length === 1 ? records[0] : undefined);
      if (record) {
        this.ensureBridge(record.host === this.host ? record : this.saveHost(record, this.host));
      } else {
        pairings.push(this.pairBridge(this.host));
      }
    } else {
      for (const record of records) {
        this.ensureBridge(record);
      }
    }

    const missing = discovered.length === 0 && records.length === 0 && !this.host;
    if (missing && !this.reportedMissing) {
      this.log.warn("No Lutron bridge found. Set host if mDNS is blocked on this network.");
    }

    this.reportedMissing = missing;

    await Promise.all(pairings);
  }

  private async pairBridge(host: string): Promise<void> {
    this.log.warn(`Found an unpaired Lutron bridge at ${host}. Press the small black button on the back of the bridge to pair.`);
    try {
      const credentials = await pair(host, {
        timeoutMs: this.dependencies.pairingTimeoutMs ?? PAIRING_TIMEOUT_MS,
        requestTimeoutMs: this.timing.requestTimeoutMs,
        connect: this.dependencies.connect
      });
      const id = await identify(host, credentials, this.dependencies.connect, this.timing.requestTimeoutMs);
      const record = { id, host, ...credentials };
      this.store.save(record);
      this.log.info(`Paired with bridge ${id} at ${host}.`);
      if (!this.stopped) {
        this.ensureBridge(record);
      }
    } catch (error) {
      this.log.warn(`Pairing with the bridge at ${host} failed: ${describe(error)}. Will retry.`);
    }
  }

  private saveHost(record: BridgeRecord, host: string): BridgeRecord {
    const updated = { ...record, host };
    try {
      this.store.save(updated);
    } catch (error) {
      this.log.warn(`Could not save the new address of bridge ${record.id}: ${describe(error)}`);
    }

    return updated;
  }

  private ensureBridge(record: BridgeRecord): void {
    if (this.stopped) {
      return;
    }

    const existing = this.bridges.get(record.id);
    if (existing) {
      existing.setHost(record.host);
      return;
    }

    const log = {
      debug: (message: string) => this.log.debug(message),
      info: (message: string) => this.log.info(message),
      warn: (message: string) => this.log.warn(message)
    };
    const bridge: LutronBridge = new LutronBridge(record, log, {
      devices: (shades, picos) => this.syncDevices(bridge, shades, picos),
      level: (zone, level) => this.applyLevel(bridge.id, zone, level),
      button: (button, event) => this.applyButton(bridge.id, button, event),
      online: (online) => {
        if (!online) {
          this.resetPicos(bridge.id);
        }
      }
    }, this.dependencies.connect, this.timing);
    this.bridges.set(record.id, bridge);
    for (const [uuid, accessory] of this.accessories) {
      const context = accessory.context as Context;
      if (context.bridge === bridge.id && context.shade && !this.controllers.has(uuid)) {
        this.controllers.set(uuid, new ShadeAccessory(this, accessory, context.shade, bridge));
      }

      if (context.bridge === bridge.id && context.pico && !this.picos.has(uuid)) {
        this.picos.set(uuid, new PicoAccessory(this, accessory, context.pico, this.pressTiming));
      }
    }

    bridge.start();
  }

  // A Pico list of undefined means the bridge could not report its buttons, so cached Picos are kept as they are.
  private syncDevices(bridge: LutronBridge, shades: readonly Shade[], picos?: readonly Pico[]): void {
    const seen = new Set<string>();
    for (const shade of shades) {
      const { uuid, accessory, cached } = this.accessoryFor(bridge, shade.serial, shade.name);
      seen.add(uuid);
      const context = accessory.context as Context;
      context.bridge = bridge.id;
      context.shade = { ...shade };
      const controller = this.controllers.get(uuid);
      if (controller) {
        controller.update(shade, bridge);
      } else {
        this.controllers.set(uuid, new ShadeAccessory(this, accessory, shade, bridge));
      }

      this.publish(accessory, cached, `shade ${shade.name}`);
    }

    for (const pico of picos ?? []) {
      const { uuid, accessory, cached } = this.accessoryFor(bridge, pico.serial, pico.name);
      seen.add(uuid);
      const context = accessory.context as Context;
      context.bridge = bridge.id;
      context.pico = { ...pico, buttons: pico.buttons.map((button) => ({ ...button })) };
      const controller = this.picos.get(uuid);
      if (controller) {
        controller.update(pico);
      } else {
        this.picos.set(uuid, new PicoAccessory(this, accessory, pico, this.pressTiming));
      }

      this.publish(accessory, cached, `Pico ${pico.name}`);
    }

    for (const [uuid, accessory] of this.accessories) {
      const context = accessory.context as Context;
      if (seen.has(uuid) || context.bridge !== bridge.id || (picos === undefined && context.pico)) {
        continue;
      }

      this.log.warn(`Removing ${context.pico ? "Pico" : "shade"} ${accessory.displayName}; the bridge no longer reports it.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.controllers.delete(uuid);
      this.picos.get(uuid)?.reset();
      this.picos.delete(uuid);
    }
  }

  private accessoryFor(bridge: LutronBridge, serial: string, name: string): { uuid: string; accessory: PlatformAccessory; cached: boolean } {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${bridge.id}:${serial}`);
    const cached = this.accessories.get(uuid);
    return { uuid, accessory: cached ?? new this.api.platformAccessory(name, uuid), cached: cached !== undefined };
  }

  private publish(accessory: PlatformAccessory, cached: boolean, label: string): void {
    if (cached) {
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info(`Adding ${label}.`);
      this.accessories.set(accessory.UUID, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  private applyLevel(bridge: string, zone: string, level: number): void {
    for (const [uuid, controller] of this.controllers) {
      if (controller.zone === zone && (this.accessories.get(uuid)?.context as Context | undefined)?.bridge === bridge) {
        controller.setLevel(level);
      }
    }
  }

  private applyButton(bridge: string, button: string, event: string): void {
    for (const [uuid, controller] of this.picos) {
      if (controller.has(button) && (this.accessories.get(uuid)?.context as Context | undefined)?.bridge === bridge) {
        controller.handle(button, event);
      }
    }
  }

  private resetPicos(bridge: string): void {
    for (const [uuid, controller] of this.picos) {
      if ((this.accessories.get(uuid)?.context as Context | undefined)?.bridge === bridge) {
        controller.reset();
      }
    }
  }
}
