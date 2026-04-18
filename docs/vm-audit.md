# VM / Compiler Audit

## Scope

This document describes the current state of the bytecode compiler and VM before deeper project changes.

Relevant files:
- [compiler.js](/C:/Users/shaar/Documents/Dev/jsvm/jsvm/compiler.js)
- [vm.js](/C:/Users/shaar/Documents/Dev/jsvm/jsvm/vm.js)
- [scripts/run-test-suite.js](/C:/Users/shaar/Documents/Dev/jsvm/jsvm/scripts/run-test-suite.js)

## Current Pipeline

The project now has a working compile -> bytecode -> execute path for a limited subset:
- literals
- variables
- arrays and objects
- property access
- arithmetic and comparisons
- `if`, `while`, `for`
- functions and simple closures
- method calls with `this`
- `await`
- minimal `import` bytecode placeholder

The VM is not an ECMAScript runtime. It is a lightweight executor for the current bytecode format.

## What Is Missing For The VM

### Language coverage missing in the compiler

These are the main blockers visible in `test262`:
- `NewExpression`
- `ClassDeclaration` and class elements
- `ThrowStatement`, `TryStatement`, `CatchClause`, `Finally`
- `SwitchStatement`
- `ForInStatement`, `ForOfStatement`
- generators and `YieldExpression`
- `ThisExpression`
- proper module semantics
- regexp literals and regexp runtime behavior
- many destructuring edge cases
- spread/rest in many contexts
- optional chaining execution semantics
- template literals
- `super`, `new.target`, private fields

If the compiler does not lower these nodes, the VM cannot support them.

### Runtime semantics missing in the VM

These are VM-level gaps even when parsing/compiling succeeds:
- lexical environments are flattened into one register map per function call
- no temporal dead zone
- no `const` immutability enforcement
- no block-scoped environment chain
- no hoisting model matching JS
- no exception propagation model
- no completion record model
- no strict/sloppy mode differences
- no prototype/class construction semantics
- no iterator protocol support
- no module loader / module namespace objects
- no import/export linkage
- no `this` binding semantics for functions vs arrows
- no `arguments` object
- no `delete` semantics matching JS
- no property descriptors / accessors semantics
- no garbage collection or lifetime model

### Bytecode features missing or underspecified

The current instruction set is still a moving target:
- `ISFC` / `ISTC` are present in the opcode table but not used by the current VM path
- `IMPORT` is a stub, not a real module system
- `SETENV` exists but is not part of a coherent scope model
- `EXIT` is not integrated into execution flow beyond returning `undefined`
- function bytecode has no explicit frame layout contract
- register allocation has no stability guarantee across refactors

## Design Issues To Fix Before Deep Changes

### 1. The bytecode format is not formally specified

Current state:
- opcodes are numeric by array index
- instruction operands are positional arrays
- some instructions changed shape during recent fixes

Impact:
- compiler and VM can drift silently
- snapshots detect drift late, not by contract

Recommendation:
- define a bytecode spec in one file
- document opcode name, operands, and meaning
- add validation for generated instruction shapes

### 2. Compiler and VM share no typed contract

Current state:
- `compiler.js` exports `OpCode` and program metadata informally
- `vm.js` assumes instruction layouts by convention

Impact:
- breakage is easy when changing operand order

Recommendation:
- introduce a shared bytecode schema module
- move opcode enum and encoder helpers there

### 3. Scope model is too weak for JavaScript

Current state:
- compile-time scopes map identifiers to registers
- runtime stores registers in a flat map per function

Impact:
- cannot model JS semantics correctly for block scopes, closures, TDZ, redeclaration, or `var`

Recommendation:
- separate:
  - lexical environment model
  - register allocation
  - global/module environment

### 4. Function calling convention is only partially designed

Current state:
- `params` stores source names
- `paramRegisters` stores assigned registers
- closures capture by shared runtime environment assumptions, not by explicit closure cells

Impact:
- nested functions and proper captures will become fragile

Recommendation:
- define a call frame structure:
  - locals
  - params
  - captured bindings
  - `this`
  - return target

### 5. Module design is placeholder-only

Current state:
- `ImportDeclaration` and `ImportExpression` compile
- VM returns synthetic namespace-like objects

Impact:
- looks supported, but semantics are not real

Recommendation:
- either keep this clearly marked as stub
- or design a real module loader before expanding import/export coverage

### 6. Debug logging is still embedded in the compiler

Current state:
- `compileProgram` prints AST and bytecode unless silenced externally

Impact:
- testing tools have to wrap the compiler to suppress logs

Recommendation:
- replace direct `console.log` with a debug option

### 7. Some compiler logic still mixes concerns

Examples:
- parsing, lowering, and debug output are in the same flow
- function metadata creation is coupled to register allocation
- import lowering and runtime policy are mixed into compiler decisions

Recommendation:
- split into:
  - parser/lowering
  - IR or bytecode builder
  - metadata emission
  - debug formatting

## Optimization Opportunities

### Low-risk optimizations

- stop using raw arrays for instructions in hot paths; use encoder helpers
- avoid repeated `normalizeString` calls for constants already known at load time
- precompute labels once per function, which the VM already does
- replace `Map` registers with arrays or indexed slots after the bytecode ABI is stable
- avoid repeated `path.relative` work in large test runs when not writing reports
- store failure samples separately from full results to reduce report size

### Medium-risk optimizations

- add constant folding in the compiler
- reuse literal registers more aggressively
- reduce redundant `MOVE` instructions
- lower conditional jumps directly instead of building intermediate boolean values when possible
- flatten nested function metadata into a table keyed by function id

### High-value `test262` runner optimizations

- support resume/checkpoint for long full-corpus runs
- store only summaries plus failing cases by default
- emit category summaries by AST node / opcode / error class
- parallelize by file batches if compiler global state remains isolated

## Concrete Errors Or Weak Spots In The Current Design

These are worth addressing before large feature work:

### Import support is currently misleading

The project now compiles import syntax, but runtime behavior is synthetic.

If the project goal is a real JS VM, this should be documented as stub behavior.

### `delete` semantics are incorrect

Current lowering mutates bindings/properties to null-like values. That is not JavaScript `delete`.

This should be redesigned before depending on it.

### `undefined` / `null` handling has already needed corrections

That is a signal that primitive representation should be explicit and centralized.

### Register allocation is not a semantic environment model

This is the most important architectural constraint. The current compiler can support a subset, but full JS semantics will not scale on top of the current environment design without refactoring.

## Recommended Refactor Order

1. Freeze the bytecode contract
2. Remove debug side effects from compiler core
3. Define call frame and environment model
4. Separate module semantics from parser coverage
5. Add exception model
6. Add constructor/class/object model
7. Expand `test262` coverage by category

## Practical Next Steps

Short term:
- add a `debug` option to `compileProgram`
- add a shared opcode/instruction schema
- classify `test262` failures by AST node type
- keep VM scope limited to the currently supported subset

Before deep VM work:
- decide whether the target is:
  - a pragmatic subset VM
  - or a JS semantics-oriented VM aiming at broad `test262` compatibility

That decision changes the right design for environments, modules, exceptions, and objects.
