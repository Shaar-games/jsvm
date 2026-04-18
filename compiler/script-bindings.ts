// @ts-nocheck
const { addStaticValue, resolveRootBindingReference } = require("./context");
const { OpCode, emit } = require("./utils");

function isScriptMode(context, mode) {
  return context.options.sourceType === "script" && context.options.scriptMode === mode;
}

function shouldExposeFunctionToGlobal(context) {
  return isScriptMode(context, "global") || isScriptMode(context, "eval");
}

function shouldExposeVarToGlobal(context) {
  return isScriptMode(context, "global");
}

function emitStoreRootBinding(context, name, valueRegister) {
  const rootReference = resolveRootBindingReference(context, name);
  if (rootReference && rootReference.depth > 0) {
    emit(context, [OpCode.STOREVAR, rootReference.depth, rootReference.binding.slot, valueRegister]);
  }
}

function emitStoreGlobalBinding(context, name, valueRegister) {
  emit(context, [OpCode.SETENV, addStaticValue(context, name), valueRegister]);
}

module.exports = {
  emitStoreGlobalBinding,
  emitStoreRootBinding,
  shouldExposeFunctionToGlobal,
  shouldExposeVarToGlobal,
};

export {};
