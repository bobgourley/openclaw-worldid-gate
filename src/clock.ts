/**
 * Clock abstraction for deterministic testing
 */

export interface Clock {
  nowSeconds(): number;
}

export class SystemClock implements Clock {
  nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }
}

export class FakeClock implements Clock {
  constructor(private currentTime: number) {}

  nowSeconds(): number {
    return this.currentTime;
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  setTime(unixSeconds: number): void {
    this.currentTime = unixSeconds;
  }
}
