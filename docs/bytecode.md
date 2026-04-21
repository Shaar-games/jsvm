# Bytecode Spec

## Overview

The VM executes array-based instructions. Each instruction is encoded as:

```js
[OPCODE, operand1, operand2, ...]
```

Programs expose:

- `filename`: source filename used for module resolution
- `sourceType`: `script` or `module`
- `staticSection.values`: shared constant pool
- `entry`: entry chunk
- `functions`: nested function table

The compiler uses two runtime storage classes:

- registers: temporary values used during expression evaluation
- lexical environments: a stack of arrays, where index `0` is the current scope and higher indices are outer scopes

## Conventions

- register operands use `R<number>` names
- lexical binding operands use `(depth, slot)`
- `depth = 0` means current lexical environment
- labels are emitted as one-element arrays, for example `["L1:"]`

## Core Data

- `LOADK destReg staticIndex`
  Loads a constant from the static section into a register.
- `GETSTATIC destReg staticIndex`
  Alias-like load used for direct static fetches.
- `MOVE destReg src`
  Copies a register/immediate value.
- `ARRAY destReg`
  Creates `[]`.
- `OBJECT destReg`
  Creates `{}`.
- `NULL destReg`
- `UNDEF destReg`
- `BOOL destReg 0|1`

## Lexical Environment

- `PUSH_ENV`
  Pushes a new lexical scope.
- `POP_ENV`
  Pops the current lexical scope.
- `PUSH_WITH objectReg`
  Pushes an object environment for `with` name resolution.
- `POP_WITH`
  Pops the current `with` object environment.
- `LOADVAR destReg depth slot`
  Loads a binding from the lexical environment stack.
- `INITVAR depth slot srcReg`
  Initializes a binding slot.
- `STOREVAR depth slot srcReg`
  Updates an existing binding slot.
- `GETNAME destReg staticIndex`
  Resolves a name dynamically against the active `with` stack, then lexical
  bindings, then the host global object.
- `SETNAME staticIndex srcReg`
  Stores through the same dynamic name resolution order used by `GETNAME`.
- `LOAD_THIS destReg`
  Loads the active `this` value for the current call frame.
- `LOAD_NEW_TARGET destReg`
  Loads the active `new.target` value, or `undefined` for ordinary calls.

Bindings currently use TDZ-like failure on read-before-init.

## Objects / Properties

- `GETFIELD destReg objectReg keyReg`
- `SETFIELD objectReg keyReg valueReg`

## Arithmetic / Comparison

- `ADD`, `SUB`, `MUL`, `DIV`, `POW`, `MOD`
- `BAND`, `BOR`, `BXOR`, `XOR`
- `LSH`, `RSH`, `ULSH`, `URSH`
- `ISEQ`, `ISNE`, `ISLT`, `ISLE`, `ISGT`, `ISGE`
- `EQ`, `NE`
  JavaScript loose equality / inequality for `==` and `!=`.
- `NOT destReg srcReg`
- `UNM destReg srcReg`
- `TYPEOF destReg srcReg`

## Control Flow

- `JUMP label`
- `JUMPF testReg label`
- `JUMPT testReg label`
- `RETURN reg|null`
- `YIELD resumeReg valueReg`
  Suspends a generator function and yields `valueReg`. When resumed through
  `.next(value)`, the sent-in value is written to `resumeReg`.
- `YIELDSTAR resumeReg iterableReg`
  Delegates iteration to the iterable in `iterableReg`. When delegation
  completes, the delegate iterator's completion value is written to `resumeReg`.
- `EXIT`

## Functions / Construction

- `CLOSURE destReg functionId`
  Creates a callable closure capturing the current lexical environments.
- `CALL fnReg argCount retReg thisReg ...argRegs`
  Invokes a callable value.
- `NEW retReg ctorReg argCount ...argRegs`
  Constructs an object via a native constructor or compiled closure constructor.
- `AWAIT destReg srcReg`

## Exceptions

- `THROW srcReg`
- `SETUP_TRY catchLabel`
  Installs a catch target for the current chunk.
- `END_TRY`
  Pops the active try handler.
- `GETERR destReg`
  Loads the pending exception captured by the VM when entering a catch block.

## Iterators / Generators

- `GETITER destReg iterableReg`
- `ITERNEXT doneReg valueReg iteratorReg`

## Modules

- `IMPORT destReg sourceReg mode`
  Loads a module namespace. `mode` is `namespace` or `dynamic`.
- `EXPORT staticIndex valueReg`
  Stores a value in the current module namespace under the static string key.
- `GETENV destReg staticIndex`
  Loads a host global by name.
- `SETENV staticIndex valueReg`
  Updates a host global by name.

## Classes

- `CLASS destReg nameReg|null superReg|null`
  Creates a class-like constructor shell.
- `SETMETHOD classReg keyReg fnReg kind isStatic`
  Attaches a constructor/method to the generated class.

## Current Limits

- lexical bindings are slot-based, but `const` write protection is not fully enforced yet
- `try/finally`, `super`, private fields, async generators and full module linkage are not complete
- class lowering covers basic constructor/prototype/static methods only
