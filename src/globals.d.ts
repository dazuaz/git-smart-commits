// Minimal global type shims so the project can typecheck without depending on
// external @types packages (this repo targets Bun at runtime).

declare const Bun: any;

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  stdout: any;
  stdin: any;
};


