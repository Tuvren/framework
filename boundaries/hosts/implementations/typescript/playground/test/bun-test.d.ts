declare module "bun:test" {
  interface Expectation {
    toBe(value: unknown): void;
    toBeGreaterThan(value: number): void;
    toContain(value: unknown): void;
    toEqual(value: unknown): void;
  }

  export function describe(name: string, run: () => void): void;
  export function expect(value: unknown): Expectation;
  export function test(name: string, run: () => Promise<void> | void): void;
}
