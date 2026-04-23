// @ts-nocheck
const { defineDataProperty } = require("./descriptors");

const TDZ = Symbol.for("jsvm.tdz");

function createEnvironment() {
  return [];
}

function getBinding(envStack, depth, slot) {
  const env = envStack[depth];
  if (!env) {
    return TDZ;
  }
  return slot in env ? env[slot] : TDZ;
}

function initBinding(envStack, depth, slot, value) {
  const env = envStack[depth];
  if (!env) {
    throw new Error(`Invalid environment depth: ${depth}`);
  }
  defineOwnIndexedValue(env, slot, value);
  return value;
}

function storeBinding(envStack, depth, slot, value) {
  const env = envStack[depth];
  if (!env) {
    throw new Error(`Invalid environment depth: ${depth}`);
  }
  if (!(slot in env)) {
    throw new ReferenceError(`Cannot assign to undeclared binding at depth ${depth}, slot ${slot}`);
  }
  defineOwnIndexedValue(env, slot, value);
  return value;
}

function defineOwnIndexedValue(target, index, value) {
  defineDataProperty(target, index, value);
}

module.exports = {
  TDZ,
  createEnvironment,
  getBinding,
  initBinding,
  storeBinding,
};

export {};
