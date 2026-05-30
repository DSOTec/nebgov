export class Logger {
  constructor(private readonly enabled: boolean) {}

  debug(...args: unknown[]): void {
    if (this.enabled) {
      console.debug(...args);
    }
  }

  warn(...args: unknown[]): void {
    if (this.enabled) {
      console.warn(...args);
    }
  }

  info(...args: unknown[]): void {
    if (this.enabled) {
      console.info(...args);
    }
  }

  error(...args: unknown[]): void {
    if (this.enabled) {
      console.error(...args);
    }
  }
}
