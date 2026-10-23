import net from "node:net";
import { Bonjour, type Service } from "bonjour-service";

export interface DiscoveredBridge {
  readonly id: string;
  readonly host: string;
}

export interface Browser {
  on(event: "up", listener: (service: Service) => void): unknown;
  update(): void;
  stop(): void;
}

export interface MdnsClient {
  find(options: { type: string; protocol: "tcp" }): Browser;
  destroy(): void;
}

export type MdnsFactory = () => MdnsClient;

export async function discoverBridges(
  timeoutMs: number,
  createClient: MdnsFactory = () => new Bonjour(undefined, () => undefined),
): Promise<DiscoveredBridge[]> {
  const found = new Map<string, string>();
  const client = createClient();
  try {
    const browser = client.find({ type: "lutron", protocol: "tcp" });
    browser.on("up", (service) => {
      const bridge = parseService(service);
      if (bridge) {
        found.set(bridge.id, bridge.host);
      }
    });
    const timer = setInterval(() => browser.update(), Math.min(timeoutMs, 1000));
    timer.unref?.();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs).unref?.();
    });
    clearInterval(timer);
    browser.stop();
  } finally {
    client.destroy();
  }

  return [...found].map(([id, host]) => ({ id, host }));
}

export function parseService(service: Pick<Service, "host" | "addresses" | "referer">): DiscoveredBridge | undefined {
  const match = /^lutron-([0-9a-f]+)\.local\.?$/iu.exec(service.host ?? "");
  if (!match) {
    return undefined;
  }

  const candidates = [...(service.addresses ?? []), service.referer?.address];
  const host = candidates.find((address): address is string => typeof address === "string" && net.isIPv4(address));
  return host ? { id: match[1].toUpperCase(), host } : undefined;
}
