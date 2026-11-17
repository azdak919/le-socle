export const MODULES = [
  "auth",
  "editorial",
  "media",
  "audience",
  "notify",
  "review",
  "export",
] as const;

export type ModuleName = (typeof MODULES)[number];

export function isModuleName(value: string): value is ModuleName {
  return (MODULES as readonly string[]).includes(value);
}

export function moduleTable(module: ModuleName): string {
  return `mod_${module}`;
}
