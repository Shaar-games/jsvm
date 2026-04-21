// @ts-nocheck
const { OpCode, emit, newRegister } = require("../utils");

async function compileMetaProperty(node, context) {
  if (
    node.meta &&
    node.meta.name === "new" &&
    node.property &&
    node.property.name === "target"
  ) {
    const register = newRegister(context);
    emit(context, [OpCode.LOAD_NEW_TARGET, register]);
    return register;
  }

  throw new Error(`Unsupported meta property: ${node.meta && node.meta.name}.${node.property && node.property.name}`);
}

module.exports = compileMetaProperty;

export {};
