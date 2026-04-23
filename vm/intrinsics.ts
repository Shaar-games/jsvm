// @ts-nocheck

function getNativeFunctionConstructor(runtimeGlobal) {
  const RuntimeFunction = runtimeGlobal && runtimeGlobal.Function;
  if (RuntimeFunction && RuntimeFunction.__jsvmNativeFunctionConstructor) {
    return RuntimeFunction.__jsvmNativeFunctionConstructor;
  }
  return RuntimeFunction || Function;
}

function getIntrinsicFunctionConstructor(NativeFunction, source) {
  try {
    return NativeFunction(`return Object.getPrototypeOf(${source}).constructor`)();
  } catch {
    return null;
  }
}

function getSpecialFunctionConstructors(runtimeGlobal, NativeFunction = getNativeFunctionConstructor(runtimeGlobal)) {
  return {
    AsyncFunction: getIntrinsicFunctionConstructor(NativeFunction, "async function() {}"),
    GeneratorFunction: getIntrinsicFunctionConstructor(NativeFunction, "function*() {}"),
    AsyncGeneratorFunction: getIntrinsicFunctionConstructor(NativeFunction, "async function*() {}"),
  };
}

function getCompiledFunctionObjectPrototype(runtimeGlobal, functionMeta) {
  if (!functionMeta) {
    return null;
  }

  if (!functionMeta.isAsync && !functionMeta.isGenerator) {
    const RuntimeFunction = runtimeGlobal && runtimeGlobal.Function;
    return RuntimeFunction && RuntimeFunction.prototype ? RuntimeFunction.prototype : null;
  }

  const constructors = getSpecialFunctionConstructors(runtimeGlobal);
  const Constructor = functionMeta.isAsync && functionMeta.isGenerator
    ? constructors.AsyncGeneratorFunction
    : functionMeta.isAsync
      ? constructors.AsyncFunction
      : constructors.GeneratorFunction;
  return typeof Constructor === "function" ? Constructor.prototype : null;
}

module.exports = {
  getCompiledFunctionObjectPrototype,
  getIntrinsicFunctionConstructor,
  getNativeFunctionConstructor,
  getSpecialFunctionConstructors,
};

export {};
