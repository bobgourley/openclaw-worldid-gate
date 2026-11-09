/**
 * Clock abstraction for deterministic testing
 */

export interface Clock {
  nowSeconds(): number;
  nowISO(): string;
}

export class SystemClock implements Clock {
  nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  nowISO(): string {
    return new Date().toISOString();
  }
}

export class FakeClock implements Clock {
  constructor(private currentTime: number = Math.floor(Date.now() / 1000)) {}

  nowSeconds(): number {
    return this.currentTime;
  }

  nowISO(): string {
    return new Date(this.currentTime * 1000).toISOString();
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  setTime(unixSeconds: number): void {
    this.currentTime = unixSeconds;
  }
}

// Alias for compatibility with test files
export { FakeClock as FrozenClock };
