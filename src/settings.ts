export const PLATFORM_NAME = "GoLutron";
export const PLUGIN_NAME = "homebridge-go-lutron";

export const LEAP_PORT = 8081;
export const PAIRING_PORT = 8083;
export const STORAGE_DIRECTORY = "go-lutron";
export const DISCOVERY_INTERVAL_MS = 300000;
export const DISCOVERY_TIMEOUT_MS = 5000;
export const PAIRING_TIMEOUT_MS = 180000;

export interface BridgeTiming {
  readonly requestTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
}

export const DEFAULT_TIMING: BridgeTiming = {
  requestTimeoutMs: 10000,
  pingIntervalMs: 60000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 60000
};
