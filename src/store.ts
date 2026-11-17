import { isModuleName, moduleTable, type ModuleName } from "./modules.ts";

export class ModuleOffError extends Error {
  readonly module: ModuleName;

  constructor(module: ModuleName) {
    super(`module éteint : ${module}`);
    this.name = "ModuleOffError";
    this.module = module;
  }
}

export interface SocleStore {
  migrate(enabled: readonly ModuleName[]): Promise<void>;
  resume(): Promise<void>;
  applied(): Promise<ModuleName[]>;
  rollback(): Promise<string | null>;
  put(module: ModuleName, key: string, value: string): Promise<void>;
  get(module: ModuleName, key: string): Promise<string | null>;
  list(module: ModuleName): Promise<Array<{ key: string; value: string }>>;
  tableReady(module: ModuleName): Promise<boolean>;
  close(): Promise<void>;
}

export function assertEnabled(enabled: ReadonlySet<ModuleName>, module: ModuleName): void {
  if (!enabled.has(module)) throw new ModuleOffError(module);
}

export function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`identifiant refusé : ${name}`);
  return `"${name}"`;
}

export function tableName(module: ModuleName): string {
  if (!isModuleName(module)) throw new Error(`module inconnu : ${module}`);
  return quoteIdent(moduleTable(module));
}
