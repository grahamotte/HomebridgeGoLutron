# Go Lutron

Homebridge plugin for Lutron Caséta shades and Pico remotes. It talks to the Smart Bridge directly over the local
LEAP API, with no Lutron cloud account.

## Features

- Discovers Caséta bridges with mDNS and pairs with the bridge button.
- Exposes each roller, honeycomb, and drapery shade as a HomeKit window covering.
- Follows changes made from Picos, the Lutron app, and schedules as they happen.
- Exposes each Pico remote as a set of HomeKit buttons, one per Pico button, so a press can run
  HomeKit scenes and automations. The Pico keeps controlling whatever the bridge assigned it to.
- Keeps shades and Picos in HomeKit while the bridge is offline and reconnects with backoff.
- Treats empty LEAP responses as empty data, and contains every bridge error, so one bad response
  cannot restart Homebridge.

## Setup

Add the platform:

```json
{
  "platform": "GoLutron"
}
```

When Homebridge finds a bridge it has not paired with, it logs a message asking you to press the
small black button on the back of the bridge. Press it within three minutes. The plugin saves the
bridge certificate under the Homebridge storage path in `go-lutron/` and does not ask again.

Dimmers, switches, and tilt-only wood blinds are not exposed.

## Options

- `host`: optional bridge address. Use it only when mDNS is blocked on your network.

## Notes

Shade positions map directly to the bridge's zone level: 0% is closed and 100% is open.

Pico buttons report three kinds of press. A long press fires once a button has been held for
0.6 seconds, which is also how holding raise or lower comes through. A double press is two taps
within 0.4 seconds, so a single press is reported 0.4 seconds after the button is released.
The pairing and LEAP message formats follow [pylutron-caseta](https://github.com/gurumitts/pylutron-caseta).
