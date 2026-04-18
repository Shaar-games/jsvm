# AGENTS.md

## Goal

This project is a JavaScript compiler + bytecode VM.

The expected architecture is:
- TypeScript-first source tree
- compiler logic split into multiple files
- one AST operation per compiler file when practical
- VM split into multiple files
- static section in compiled programs
- bytecode instructions inspired by Lua / LuaJIT, extended for JavaScript semantics
- lexical environments and registers kept separate at runtime

## Compiler rules

- Real compiler code lives under `compiler/`.
- The compiler entrypoint is `compiler/index.ts`.
- Each supported AST operation should have a dedicated file.
  Examples:
  - `compiler/expressions/ObjectExpression.ts`
  - `compiler/expressions/CallExpression.ts`
  - `compiler/statements/IfStatement.ts`
- Shared compiler state belongs in `compiler/context.ts`.
- Shared compiler types belong in `compiler/types.ts`.
- Shared opcode / instruction definitions belong in `bytecode/opcodes.ts`.
- Use a static section for constant values.
- Prefer a dedicated instruction to load constants from the static section instead of inlining values everywhere.
- Do not add root-level compatibility wrappers unless there is a concrete external integration that still needs them.

## VM rules

- Real VM code lives under `vm/`.
- The VM entrypoint is `vm/index.ts`.
- Registers and lexical environments are different storage classes.
- Registers are for temporaries.
- Lexical environments are a stack of arrays indexed by lexical depth.
- `depth = 0` is the current environment, larger depths are outer scopes.
- VM execution must consume the compiler output directly.
- Do not reintroduce the old `frame` abstraction now that `registers` and `environment` are explicit modules.
- The long-term target is a complete execution system: local code loaded through `import` or `require` should be compiled and then executed by the VM, not bypassed through host evaluation.
- Test harness code should be compiled through the same pipeline whenever practical; keep runtime-only helpers limited to cases that cannot yet be expressed through the compiler/VM.

## Opcode guidance

- The opcode list is inspired by Lua / LuaJIT.
- It is acceptable to add opcodes because JavaScript semantics are more complex.
- If an opcode is added:
  - define it in `bytecode/opcodes.ts`
  - document its operand shape in [docs/bytecode.md](/C:/Users/shaar/Documents/Dev/jsvm/jsvm/docs/bytecode.md)
  - implement it in the VM before relying on it in the compiler

## Static section

- Compiled programs should expose a static section.
- The VM should load constants through instructions such as `LOADK` / `GETSTATIC`.
- Strings, property names, module specifiers, and reusable literal values should go there first.

## Design constraints

- Do not hide semantics inside ad hoc register tricks when they belong to environments or stack frames.
- Prefer explicit, testable instruction shapes over implicit conventions.
- When behavior is only a stub, keep that explicit in code and documentation.
- Keep the root of the repo small. New runtime/compiler code belongs under `compiler/`, `vm/`, `bytecode/`, `scripts/`, or `docs/`.
- Generated output belongs in `dist/` only.
- Delete dead compatibility files instead of keeping duplicate entrypoints around.

## Recommended additions

- More VM smoke tests for closures, nested scopes, and imports.
- A category report for `test262` failures by AST node / opcode / runtime area.
- A real module loader only after the current import stub is clearly isolated.

## Current workflow

- `npm run build`
- `npm run test:local`
- `npm run test:test262`
- `npm run test:snapshots`
- `npm run test:snapshots:update`
- `npm run vm:test`

## Runner constraints

- Do not run the VM runner in parallel with `npm run build` or `npm run test:test262`.
- `build` deletes `dist/`, which breaks the worker-based VM runner if both execute at the same time.
- Run build/test262 compilation first, then launch VM runs sequentially.

## Technical priorities

1. Stabilize the bytecode contract.
2. Keep compiler handlers modular.
3. Keep lexical environment semantics explicit.
4. Move module loading toward a unified `import` / `require` pipeline that compiles local dependencies.
5. Expand feature support incrementally with tests and snapshots.
6. Remove dead files when architecture changes make them obsolete.
