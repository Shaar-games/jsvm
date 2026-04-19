# test262 Node Host VM Profile

## Goal

The VM runner can execute `test262` under different host assumptions.

The current default profile is `node`.

In this profile, the runner executes only tests that can reasonably work on a
Node host runtime with the current compiler + VM architecture. Tests that
require browser-only host semantics are filtered out before worker execution.

## What The Node Host Filter Removes

The filter currently removes tests declared incompatible with the Node host in
`scripts/test262-metadata.ts`.

### `IsHTMLDDA`

`IsHTMLDDA` is the main excluded feature today.

These tests depend on browser host behavior similar to `document.all`, with
 engine-level semantics that userland JavaScript cannot reproduce faithfully:

- `typeof value === "undefined"` for a host object
- abstract equality special-casing with `null` / `undefined`
- `ToBoolean` special-casing

Binding native Node globals into the VM is not enough for these tests because
Node does not expose a real `IsHTMLDDA` host value.

These tests should stay excluded in the `node` host profile.

They may become runnable in a browser-host profile only if the VM receives the
real browser `document` by reference and preserves `document.all` without
wrapping, cloning, or normalizing it.

## What Still Appears As Unsupported In Node

After host filtering, unsupported tests in the Node profile should mostly come
from project limitations rather than host mismatch.

Current examples:

- `YieldExpression`
- invalid assignment target parse/compile failures
- `LabeledStatement` before compiler support lands

These are compiler / VM gaps, not host-runtime gaps.

## Why Filtering Happens Before Worker Execution

Filtering incompatible tests early has two goals:

- avoid spending worker time on known host-incompatible cases
- make the VM coverage metric reflect the real Node-executable subset

This means the reported `test262-vm` totals in Node profile describe:

- tests runnable on Node host
- with the current harness / compiler / VM support

They do not describe the full browser-host reachable surface.
