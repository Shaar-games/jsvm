# VM and Compiler Implementation Workflow

This project is implemented incrementally against local fixtures and Test262.
Each pass should keep the bytecode contract explicit and leave a reproducible
test trail.

## 1. Start From The First Real Failure

Run the broad suite in fail-fast mode:

```sh
node dist/scripts/run-test-suite.js --test262 --test262-vm --fail-fast
```

Use the first compiler failure and the first VM failure from
`reports/test-report.json` as the next work items. Avoid batch-fixing unrelated
areas unless they share the same root cause.

For focused debugging, use `--filter=` and, when needed, `--skip=`:

```sh
node dist/scripts/run-test-suite.js --no-local --no-test262-vm --filter="path\\to\\test.js" --fail-fast
node dist/scripts/run-test-suite.js --no-local --no-test262 --test262-vm --filter="path\\to\\test.js" --fail-fast
```

## 2. Classify The Gap

Before editing, identify whether the failure is:

- parser support: Acorn/Babel accepts or rejects the source incorrectly for the
  runner's current mode
- compiler lowering: an AST node or operator has no handler, or emits an
  insufficient instruction sequence
- bytecode contract: a new semantic operation needs a dedicated instruction
- VM execution: an existing opcode has incorrect JavaScript semantics
- runtime normalization: a host builtin needs realm, descriptor, species,
  iterator, or legacy behavior normalization
- harness behavior: Test262 metadata, strict mode, includes, async completion,
  or realm setup is not represented correctly

Prefer fixing the lowest layer that owns the semantics. For example, object
spread belongs in bytecode/VM support, not in an ad hoc compiler-only
`Object.assign` lowering.

## 3. Add Bytecode Deliberately

When adding an opcode:

1. Add the opcode to `bytecode/opcodes.ts`.
2. Document its operand shape in `docs/bytecode.md`.
3. Emit it from the compiler only after the VM handler exists.
4. Keep operand order consistent with nearby instructions.

New opcodes should model JavaScript semantics that are hard to express safely
with existing instructions. Do not hide observable behavior in register tricks.

## 4. Keep Compiler Handlers Modular

Compiler support should live under `compiler/`:

- expressions in `compiler/expressions/`
- statements in `compiler/statements/`
- shared lowering helpers in existing shared modules or a new focused helper

If two handlers need the same lowering pattern, extract a helper instead of
duplicating instruction sequences.

## 5. Preserve Runtime Storage Boundaries

Registers are temporary values. Lexical environments are binding storage.

Do not reintroduce a frame abstraction that mixes registers, lexical bindings,
`this`, and control state. If a new semantic needs runtime context, add an
explicit state field or opcode operand and document it.

## 6. Validate In Three Steps

After a fix:

1. Rebuild:

   ```sh
   npm run build
   ```

2. Run the targeted compiler or VM Test262 case with `--fail-fast`.
3. Run local coverage:

   ```sh
   npm run test:local
   ```

Then run the broad fail-fast suite again and record the next first failure:

```sh
node dist/scripts/run-test-suite.js --test262 --test262-vm --fail-fast
```

Do not run build and the VM runner in parallel. `npm run build` deletes `dist/`,
which can break worker-based VM runs.

## 7. Runtime Builtins Policy

Runtime builtin fixes should preserve observable descriptors, realm behavior,
species behavior, and strict/sloppy `this` binding. Prefer small normalization
functions near related runtime helpers.

When native methods are not realm-correct for the VM environment, implement a
manual path that uses shared helpers such as species construction and own data
property definition. Keep native delegation for cases where the host behavior is
known to match and the VM does not need interposition.

## 8. Report The Result

For each implementation pass, report:

- files changed at a high level
- targeted tests that passed
- local test result
- broad fail-fast result
- the next compiler and VM failures, if any
