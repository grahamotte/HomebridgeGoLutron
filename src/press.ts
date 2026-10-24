export type Press = "single" | "double" | "long";

export interface PressTiming {
  readonly longPressMs: number;
  readonly doublePressMs: number;
}

// Turns the bridge's raw Press and Release events for one button into single, double, and long presses.
// A tap waits doublePressMs for a second tap before it counts as a single press; with doublePressMs 0 it
// fires on release. Holding past longPressMs fires a long press while the button is still down.
export class PressDetector {
  private down = false;
  private second = false;
  private held = false;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private tapTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly timing: PressTiming,
    private readonly emit: (press: Press) => void,
  ) {}

  handle(event: string): void {
    switch (event) {
      case "Press":
        this.press();
        break;
      case "Release":
        this.release();
        break;
      case "LongHold":
        this.hold();
        break;
      case "MultiTap":
        this.reset();
        this.fire(this.timing.doublePressMs > 0 ? "double" : "single");
        break;
    }
  }

  reset(): void {
    this.down = false;
    this.second = false;
    this.held = false;
    this.clearTimers();
  }

  private press(): void {
    const second = this.tapTimer !== undefined;
    this.clearTimers();
    this.down = true;
    this.second = second;
    this.held = false;
    this.holdTimer = setTimeout(() => this.hold(), this.timing.longPressMs);
    this.holdTimer.unref?.();
  }

  private hold(): void {
    if (this.held) {
      return;
    }

    this.clearTimers();
    this.held = true;
    this.second = false;
    this.fire("long");
  }

  private release(): void {
    if (!this.down) {
      return;
    }

    const { held, second } = this;
    this.reset();
    if (held) {
      return;
    }

    if (second) {
      this.fire("double");
    } else if (this.timing.doublePressMs <= 0) {
      this.fire("single");
    } else {
      this.tapTimer = setTimeout(() => {
        this.tapTimer = undefined;
        this.fire("single");
      }, this.timing.doublePressMs);
      this.tapTimer.unref?.();
    }
  }

  private fire(press: Press): void {
    try {
      this.emit(press);
    } catch {
      return;
    }
  }

  private clearTimers(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
    }

    if (this.tapTimer) {
      clearTimeout(this.tapTimer);
      this.tapTimer = undefined;
    }
  }
}
