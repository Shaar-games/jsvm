// @ts-nocheck
const { compileExpression } = require("../dispatch/expressions");
const { resolveBindingReference } = require("../context");
const { OpCode, addStaticValue, emit, compileLiteralValue, newRegister, storeBindingValue } = require("../utils");

async function compileUnaryExpression(node, context) {
  const resultRegister = newRegister(context);

  if (node.operator === "delete") {
    if (node.argument.type === "MemberExpression") {
      const objectRegister = await compileExpression(node.argument.object, context);
      const propertyRegister = node.argument.computed
        ? await compileExpression(node.argument.property, context)
        : compileLiteralValue(node.argument.property.name, context);
      emit(context, [OpCode.DELETEFIELD, resultRegister, objectRegister, propertyRegister]);
      return resultRegister;
    }

    if (node.argument.type === "Identifier") {
      storeBindingValue(context, node.argument.name, compileLiteralValue(undefined, context));
      emit(context, [OpCode.BOOL, resultRegister, 1]);
      return resultRegister;
    }

    throw new Error(`Unsupported argument for delete: ${node.argument.type}`);
  }

  if (node.operator === "typeof" && node.argument.type === "Identifier") {
    if (context.withDepth > 0) {
      emit(context, [OpCode.TYPEOFNAME, resultRegister, addStaticValue(context, node.argument.name)]);
      return resultRegister;
    }

    const reference = resolveBindingReference(context, node.argument.name);
    if (!reference) {
      emit(context, [OpCode.TYPEOFNAME, resultRegister, addStaticValue(context, node.argument.name)]);
      return resultRegister;
    }

    const argumentRegister = newRegister(context);
    emit(context, [OpCode.LOADVAR, argumentRegister, reference.depth, reference.binding.slot]);
    emit(context, [OpCode.TYPEOF, resultRegister, argumentRegister]);
    return resultRegister;
  }

  const argumentRegister = await compileExpression(node.argument, context);
  switch (node.operator) {
    case "-":
      emit(context, [OpCode.UNM, resultRegister, argumentRegister]);
      break;
    case "!":
      emit(context, [OpCode.NOT, resultRegister, argumentRegister]);
      break;
    case "+":
      emit(context, [OpCode.MOVE, resultRegister, argumentRegister]);
      break;
    case "~": {
      const allOnesRegister = compileLiteralValue(-1, context);
      emit(context, [OpCode.XOR, resultRegister, argumentRegister, allOnesRegister]);
      break;
    }
    case "typeof":
      emit(context, [OpCode.TYPEOF, resultRegister, argumentRegister]);
      break;
    case "void":
      emit(context, [OpCode.UNDEF, resultRegister]);
      break;
    default:
      throw new Error(`Unsupported unary operator: ${node.operator}`);
  }

  return resultRegister;
}

module.exports = compileUnaryExpression;

export {};
