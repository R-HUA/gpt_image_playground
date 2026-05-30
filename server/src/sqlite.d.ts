declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(filename: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }

  export interface StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    get(...params: unknown[]): Record<string, unknown> | undefined
    all(...params: unknown[]): Array<Record<string, unknown>>
  }
}
