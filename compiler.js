const acorn = require('acorn');
const fs = require('fs');
// Enumeration for opcodes

const types = {
  "String": 0,
  "Number": 1,
  "Bigint": 2,
  "Boolean": 3,
  "Undefined": 4,
  "Null": 5,
  "Symbol": 6,
  "Object": 7,
};

const OpCode = {
  ADDVN: 'ADDVN',
  ADDNV: 'ADDNV',
  ADDVV: 'ADDVV',
  ADDNN: 'ADDNN',
  SUBVV: 'SUBVV',
  MULVV: 'MULVV',
  DIVVV: 'DIVVV',
  MOV: 'MOV',
  LOAD: 'LOAD',
  ISLT: 'ISLT',
  ISGE: 'ISGE',
  ISLE: 'ISLE',
  ISGT: 'ISGT',
  ISEQV: 'ISEQV',
  ISNEV: 'ISNEV',
  JMP: 'JMP',
  CALL: 'CALL',
  RET: 'RET',
  FNEW: 'FNEW',
  GC: 'GC',
  ASETV: 'ASETV',
  ANEW: 'ANEW',
  AGETV: 'AGETV',
  ONEW: 'ONEW',
  OSETV: 'OSETV',
  OGETV: 'OGETV',
  BANDVV: 'BANDVV',
  BORVV: 'BORVV',
  BXORVV: 'BXORVV',
  LSHVV: 'LSHVV',
  RSHVV: 'RSHVV',
  ULSHVV: 'ULSHVV',
  URSHVV: 'URSHVV',
  ANDVV: 'ANDVV',
  ORVV: 'ORVV',
  MODVV: 'MODVV',
  POWVV: 'POWVV',
  ISFC: 'ISFC',
  ISTC: 'ISTC',
  NOT: 'NOT',
  UNM: 'UNM',
  XOR: 'XOR',
  GGETV: 'GGET',
  GSETV: 'GSET',
  AWAIT: 'AWAIT',
  TYPEOF: 'TYPEOF',
  EXIT: 'EXIT',
};

function newRegister(context) {
  if (context.freeRegisters.length > 0) {
    // Reuse a register from the free pool
    return context.freeRegisters.pop();
  } else {
    // Allocate a new register
    context.nextRegister = context.nextRegister + 1;
    const r = `R${context.nextRegister}`;
    return r;
  }
}

function freeRegister(context, register) {
  context.freeRegisters.push(register);
}

async function compileProgram(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module", locations: true });

  const context = {
    bytecode: {
      length: 0,
      array: [],
      push: function (line) {
        this.array.push(line);
        this.length++;
      },
      join: function (separator) {
        return this.array.map(line => line.join(' ')).join(separator);
      },
    },
    scopeStack: [new Map()],
    nextRegister: 0,
    labelCounter: 0,
    functions: new Map(),
    loopLabels: [],
    freeRegisters: [],
  };

  await compileBlockStatement(ast, context);

  console.log(context.functions);

  // Append function bytecodes to the main bytecode
  context.functions.forEach(func => {
    console.log("---", "BYTECODE", "---", func.name);
    func.bytecode.array.forEach(line => {
      console.log(line.join(' '));
    });
  });

  return context.bytecode;
}

// Function to get a register for a variable
function getRegister(context, name) {
  // Look for the variable in the current scope
  const currentScope = context.scopeStack[context.scopeStack.length - 1];
  if (!currentScope.has(name)) {
    // Assign a new register if the variable is not declared in the current scope
    const register = newRegister(context);
    currentScope.set(name, register);
  }

  // search in function context
  return currentScope.get(name);
}

// Function to compile a block of code
async function compileBlockStatement(node, context) {
  // Create a new scope for this block
  context.scopeStack.push(new Map());

  for (const statement of node.body) {
    await compileStatement(statement, context);
  }

  // Exit the current scope
  context.scopeStack.pop();
}

// Function to compile a for statement
async function compileForStatement(node, context) {
  const labelStart = `L${++context.labelCounter}`;
  const labelEnd = `L${++context.labelCounter}`;

  // Compile initializer
  if (node.init) {
    await compileStatement(node.init, context);
  }

  // Push the current loop's labels onto the loopLabels stack
  context.loopLabels.push({ start: labelStart, end: labelEnd });

  // Label for the beginning of the loop
  context.bytecode.push([labelStart + ':']);

  // Compile test condition
  if (node.test) {
    const testReg = await compileExpression(node.test, context);
    // If the test fails, jump to the end
    context.bytecode.push([OpCode.JMP, labelEnd]);
    freeRegister(context, testReg);
  }

  // Compile the loop body
  await compileStatement(node.body, context);

  // Compile update expression
  if (node.update) {
    await compileExpression(node.update, context);
  }

  // Jump back to the start of the loop
  context.bytecode.push([OpCode.JMP, labelStart]);

  // Label for the end of the loop
  context.bytecode.push([labelEnd + ':']);

  // Pop the current loop's labels off the loopLabels stack
  context.loopLabels.pop();
}

// Function to emit GC instructions for the current scope
function emitGCInstructions(context) {
  const currentScope = context.scopeStack[context.scopeStack.length - 1];
  currentScope.forEach(register => {
    if (!context.freeRegisters.includes(register)) {
      freeRegister(context, register); // Mark the register as reusable
    }
  });
}

async function compileForOfStatement(node, context) {
  // will be implemented in the future
}

// Function to compile a continue statement
function compileContinueStatement(node, context) {
  if (context.loopLabels.length === 0) {
    throw new Error(`'continue' used outside of a loop`);
  }

  // Get the current loop's start label
  const labelStart = context.loopLabels[context.loopLabels.length - 1].start;

  // Emit jump to the start of the loop
  context.bytecode.push([OpCode.JMP, labelStart]);
}

// Extend the compileStatement function to handle ContinueStatement
async function compileStatement(node, context) {
  switch (node.type) {
    case 'VariableDeclaration':
      await compileVariableDeclaration(node, context);
      break;
    case 'ExpressionStatement':
      await compileExpression(node.expression, context);
      break;
    case 'ReturnStatement':
      const returnValue = await compileExpression(node.argument, context);
      context.bytecode.push([OpCode.RET, returnValue]);
      break;
    case 'IfStatement':
      await compileIfStatement(node, context);
      break;
    case 'WhileStatement':
      await compileWhileStatement(node, context);
      break;
    case 'ForStatement':
      await compileForStatement(node, context);
      break;
    case 'ForOfStatement':
      await compileForOfStatement(node, context);
      break;
    case 'BlockStatement':
      await compileBlockStatement(node, context);
      break;
    case 'FunctionDeclaration':
      await compileFunctionDeclaration(node, context);
      break;
    case 'BreakStatement':
      compileBreakStatement(node, context);
      break;
    case 'ContinueStatement':
      compileContinueStatement(node, context);
      break;
    case 'EmptyStatement':
      break;
    default:
      throw new Error(`Unsupported statement type: ${node.type}`);
  }
}

// Function to compile a break statement
function compileBreakStatement(node, context) {
  const labelEnd = context.loopLabels[context.loopLabels.length - 1].end;
  context.bytecode.push([OpCode.JMP, labelEnd]);
}

async function compileObjectPattern(declaration, context) {
  // Compile the right-hand side expression (the object to destructure)
  const sourceReg = await compileExpression(declaration.init, context);

  // Iterate over each property in the object pattern
  for (const property of declaration.id.properties) {
    const key = property.key.name;
    const valueReg = newRegister(context);

    // Check if the property key is computed
    if (property.computed) {
      const keyReg = await compileExpression(property.key, context);
      context.bytecode.push([OpCode.OGETV, valueReg, sourceReg, keyReg]);
      freeRegister(context, keyReg);
    } else {
      context.bytecode.push([OpCode.OGETV, valueReg, sourceReg, `"${key}"`]);
    }

    // Generate bytecode to extract the property value from the object
    // Assign the extracted value to the variable name in the pattern
    if (property.value.type === 'Identifier') {
      const varName = property.value.name;
      const varReg = getRegister(context, varName);
      context.bytecode.push([OpCode.MOV, varReg, valueReg]);
    } else {
      throw new Error(`Unsupported pattern element: ${property.value.type}`);
    }

    // Free the value register after use
    freeRegister(context, valueReg);
  }

  // Free the source register after destructuring
  freeRegister(context, sourceReg);
}

// Fonction pour compiler un motif de tableau (déstructuration d'affectation)
async function compileArrayPattern(declaration, context) {
  // Compile l'expression du côté droit (le tableau à déstructurer)
  const sourceReg = await compileExpression(declaration.init, context);

  // Détermine s'il y a un RestElement dans le tableau
  let restIndex = -1;
  for (let index = 0; index < declaration.id.elements.length; index++) {
    const element = declaration.id.elements[index];
    if (element && element.type === 'RestElement') {
      restIndex = index;
      break;
    }
  }

  // Gérer chaque élément dans le tableau avant le RestElement
  for (let index = 0; index < (restIndex === -1 ? declaration.id.elements.length : restIndex); index++) {
    const element = declaration.id.elements[index];
    if (element === null) continue; // Passer les trous dans le tableau

    const valueReg = newRegister(context);
    const indexReg = newRegister(context);
    context.bytecode.push([OpCode.LOAD, types.Number, indexReg, index]);
    context.bytecode.push([OpCode.AGETV, valueReg, sourceReg, index]);

    // Gérer les éléments avec des valeurs par défaut
    if (element.type === 'AssignmentPattern') {
      const left = element.left;
      const right = element.right;

      if (left.type !== 'Identifier') {
        throw new Error(`Unsupported pattern element in array: ${left.type}`);
      }

      const varName = left.name;
      const varReg = getRegister(context, varName);

      // Génère du bytecode pour vérifier si la valeur est indéfinie et utiliser la valeur par défaut
      const defaultReg = await compileExpression(right, context);
      const isUndefinedReg = newRegister(context);

      context.bytecode.push([OpCode.ISNEV, isUndefinedReg, valueReg]);
      context.bytecode.push([OpCode.JMP, `L${context.labelCounter + 1}`, isUndefinedReg]);

      // Assigne la valeur à la variable
      context.bytecode.push([OpCode.MOV, varReg, valueReg]);
      context.bytecode.push([OpCode.JMP, `L${context.labelCounter + 2}`]);

      // Assigne la valeur par défaut
      context.bytecode.push([`L${context.labelCounter + 1}:`]);
      context.bytecode.push([OpCode.MOV, varReg, defaultReg]);

      // Fin de cette assignation
      context.bytecode.push([`L${context.labelCounter + 2}:`]);

      // Incrémente le compteur de labels
      context.labelCounter += 2;

      freeRegister(context, defaultReg);
      freeRegister(context, isUndefinedReg);
    } else if (element.type === 'Identifier') {
      const varName = element.name;
      const varReg = getRegister(context, varName);
      context.bytecode.push([OpCode.MOV, varReg, valueReg]);
    } else {
      throw new Error(`Unsupported pattern element in array: ${element.type}`);
    }

    // Libère le registre de la valeur après utilisation
    freeRegister(context, valueReg);
    freeRegister(context, indexReg);
  }

  // Gérer le RestElement s'il existe
  if (restIndex !== -1) {
    const restElement = declaration.id.elements[restIndex];
    const restVarName = restElement.argument.name;
    const restVarReg = getRegister(context, restVarName);

    // Créer un nouveau tableau pour les éléments restants
    const restArrayReg = newRegister(context);
    context.bytecode.push([OpCode.ANEW, restArrayReg]);

    // Obtenir la longueur du tableau source
    const lengthReg = newRegister(context);
    context.bytecode.push([OpCode.AGETV, lengthReg, sourceReg, `"length"`]);

    // Itérer sur les éléments restants et les ajouter au tableau restant , starting from restIndex to lengthReg-1

    const indexReg = newRegister(context);
    context.bytecode.push([OpCode.LOAD, types.Number, indexReg, restIndex]);
    context.bytecode.push([`L${context.labelCounter}:`]);
    const loopReg = newRegister(context);
    context.bytecode.push([OpCode.SUBVV, loopReg, lengthReg, indexReg]);
    context.bytecode.push([OpCode.ISEQV, restVarReg, indexReg, lengthReg]);
    context.bytecode.push([OpCode.JMP, `L${context.labelCounter + 1}`, restVarReg]);
    // Get the value from the source array
    const valueReg = newRegister(context);
    context.bytecode.push([OpCode.AGETV, valueReg, sourceReg, indexReg]);
    // Set the value in the destination array
    context.bytecode.push([OpCode.ASETV, restArrayReg, indexReg, valueReg]);
    // Increment the index
    context.bytecode.push([OpCode.ADDVN, indexReg, indexReg, 1]);
    // Jump back to the start of the loop
    context.bytecode.push([OpCode.JMP, `L${context.labelCounter}`]);
    // Label for the end of the loop
    context.bytecode.push([`L${context.labelCounter + 1}:`]);

    // Assign the rest array to the variable
    context.bytecode.push([OpCode.MOV, restVarReg, restArrayReg]);

    // Libère les registres après utilisation
    freeRegister(context, restArrayReg);
    freeRegister(context, lengthReg);
    freeRegister(context, indexReg);
    freeRegister(context, valueReg);
  }

  // Libère le registre source après la déstructuration
  freeRegister(context, sourceReg);
}

// Function to compile a variable declaration
async function compileVariableDeclaration(node, context) {
  for (const declaration of node.declarations) {
    if (declaration.id.type === 'ObjectPattern') {
      // Handle object destructuring
      await compileObjectPattern(declaration, context);
    } else if (declaration.id.type === 'ArrayPattern') {
      // Handle array destructuring
      await compileArrayPattern(declaration, context);
    } else if (declaration.id.type === 'Identifier') {
      // Regular variable declaration
      const name = declaration.id.name;
      const value = await compileExpression(declaration.init, context);
      const destReg = getRegister(context, name);
      context.bytecode.push([OpCode.MOV, destReg, value]);
      freeRegister(context, value);
    } else {
      throw new Error(`Unsupported declaration type: ${declaration.id.type}`);
    }
  }
}

// Function to compile an array expression
async function compileArrayExpression(node, context) {
  const register = newRegister(context);
  // Crée un tableau vide et réserve un registre pour ce tableau
  context.bytecode.push([OpCode.ANEW, register]);

  // Traite chaque élément du tableau et les assigne à des indices dans le tableau
  for (let i = 0; i < node.elements.length; i++) {
    const element = node.elements[i];
    const elementRegister = await compileExpression(element, context);
    // create a new register to store the index
    const iReg = newRegister(context);
    context.bytecode.push([OpCode.LOAD, types.Number, iReg, i]);
    context.bytecode.push([OpCode.ASETV, register, iReg, elementRegister]);
    // Libère le registre de l'élément après utilisation
    freeRegister(context, iReg);
    freeRegister(context, elementRegister);
  }

  return register; // Retourne le registre où le tableau est stocké
}

async function compileUpdateExpression(node, context) {
  // Resolve the register for the variable being updated
  const argReg = resolveIdentifier(context, node.argument.name);

  // Determine the operation based on the operator
  let opcode;
  switch (node.operator) {
    case '++':
      opcode = OpCode.ADDVV;
      break;
    case '--':
      opcode = OpCode.SUBVV;
      break;
    default:
      throw new Error(`Unsupported update operator: ${node.operator}`);
  }

  // Create a new register for the constant 1
  const oneReg = newRegister(context);
  context.bytecode.push([OpCode.LOAD, types.Number, oneReg, 1]);

  // Apply the operation and update the register
  context.bytecode.push([opcode, argReg, argReg, oneReg]);

  // If the expression is a prefix operation, return the updated value
  if (node.prefix) {
    return argReg;
  } else {
    // For postfix, create a temporary register to store the original value
    const tempReg = newRegister(context);
    context.bytecode.push([OpCode.MOV, tempReg, argReg]);
    return tempReg;
  }
}

// Function to compile a member expression
async function compileMemberExpression(node, context) {
  const objectRegister = await compileExpression(node.object, context);

  let propertyRegister;
  if (node.computed) {
    // For computed properties, like console['log']
    propertyRegister = await compileExpression(node.property, context);
  } else {
    // For non-computed properties, like console.log
    propertyRegister = newRegister(context);
    context.bytecode.push([OpCode.LOAD, types.String, propertyRegister, `"${node.property.name}"`]);
  }

  const resultRegister = newRegister(context);

  if (node.computed) {
    // If the property is an index, access it as an array
    context.bytecode.push([OpCode.AGETV, resultRegister, objectRegister, propertyRegister]);
  } else {
    // Otherwise, access it as an object property
    context.bytecode.push([OpCode.OGETV, resultRegister, objectRegister, propertyRegister]);
  }

  return resultRegister;
}

async function compileObjectExpression(node, context) {
  const objectRegister = newRegister(context); // Create a new register for the object

  // Emit instruction to create a new object
  context.bytecode.push([OpCode.ONEW, objectRegister]); // Reuse ANEW opcode for object creation

  for (const property of node.properties) {
    // Compile the property value
    const valueRegister = await compileExpression(property.value, context);

    // Handle computed and non-computed keys
    let keyRegister;
    if (property.computed) {
      keyRegister = await compileExpression(property.key, context);
    } else {
      keyRegister = newRegister(context);
      context.bytecode.push([OpCode.LOAD, types.String, keyRegister, `"${property.key.name || property.key.value}"`]);
    }

    // Assign the value to the object using the key
    context.bytecode.push([OpCode.OGETV, objectRegister, keyRegister, valueRegister]);
  }

  // Add the new register to the current scope

  return objectRegister; // Return the register where the object is stored
}

async function compileLogicalExpression(node, context) {
  const leftReg = await compileExpression(node.left, context);
  const resultReg = newRegister(context);

  const labelEnd = `L${++context.labelCounter}`;
  const labelRightEval = `L${++context.labelCounter}`;

  if (node.operator === '&&') {
    // For '&&', if the left is false, jump to the end
    context.bytecode.push([OpCode.ISFC, leftReg, labelRightEval]);
    context.bytecode.push([OpCode.JMP, labelEnd]);
  } else if (node.operator === '||') {
    // For '||', if the left is true, jump to the end
    context.bytecode.push([OpCode.ISTC, leftReg, labelRightEval]);
    context.bytecode.push([OpCode.JMP, labelEnd]);
  } else {
    throw new Error(`Unsupported logical operator: ${node.operator}`);
  }

  // Label to evaluate the right operand
  context.bytecode.push([labelRightEval + ':']);
  const rightReg = await compileExpression(node.right, context);
  context.bytecode.push([OpCode.MOV, resultReg, rightReg]);
  context.bytecode.push([OpCode.JMP, labelEnd]);

  // Label for the end of the expression
  context.bytecode.push([labelEnd + ':']);
  context.bytecode.push([OpCode.MOV, resultReg, leftReg]);

  return resultReg;
}

async function compileUnaryExpression(node, context) {
  const resultReg = newRegister(context);

  if (node.operator === "delete") {
    if (node.argument.type === "MemberExpression") {
      // For deleting a property, set it to null and perform GC
      const objReg = await compileExpression(node.argument.object, context);
      let propReg;

      if (node.argument.computed) {
        propReg = await compileExpression(node.argument.property, context);
      } else {
        propReg = newRegister(context);
        context.bytecode.push([OpCode.LOAD, types.String, propReg, `"${node.argument.property.name}"`]);
      }

      const nullReg = newRegister(context);
      context.bytecode.push([OpCode.LOAD, types.Null, nullReg, 0]);
      context.bytecode.push([OpCode.OSETV, objReg, propReg, nullReg]);

      freeRegister(context, nullReg);
      freeRegister(context, propReg);

      // Set the result register to indicate success
      context.bytecode.push([OpCode.LOAD, types.Boolean, resultReg, 1]);

      return resultReg;

    } else if (node.argument.type === "Identifier") {
      // For deleting a variable, set it to null and perform GC
      const varReg = resolveIdentifier(context, node.argument.name);
      context.bytecode.push([OpCode.LOAD, types.Null, varReg, 0]);
      // Set the result register to indicate success
      context.bytecode.push([OpCode.LOAD, types.Boolean, resultReg, 1]);
    } else {
      throw new Error(`Unsupported argument for 'delete': ${node.argument.type}`);
    }

    return resultReg;
  } else {
    const argReg = await compileExpression(node.argument, context);

    switch (node.operator) {
      case "-":
        // Unary minus: Set result to negative of the argument
        context.bytecode.push([OpCode.UNM, resultReg, argReg]);
        break;
      case "!":
        // Logical NOT: Set result to boolean not of the argument
        context.bytecode.push([OpCode.NOT, resultReg, argReg]);
        break;
      case "+":
        // Unary plus: Simply copy the argument to the result
        context.bytecode.push([OpCode.MOV, resultReg, argReg]);
        break;
      case "~":
        // Bitwise NOT: Typically requires XOR with -1
        const allOnesReg = newRegister(context);
        context.bytecode.push([OpCode.MOV, allOnesReg, -1]);
        context.bytecode.push([OpCode.XOR, resultReg, argReg, allOnesReg]);
        break;
      case "typeof":
        // Determine the type of the argument and set the result
        // create a new register to store the type
        const typeReg = newRegister(context);
        context.bytecode.push([OpCode.TYPEOF, typeReg, argReg]);
        context.bytecode.push([OpCode.MOV, resultReg, typeReg]);
        freeRegister(context, typeReg);
        break;
      case "void":
        // Set the result to undefined
        context.bytecode.push([OpCode.LOAD, types.Undefined, resultReg, 0]);
        break;
      default:
        throw new Error(`Unsupported unary operator: ${node.operator}`);
    }

    return resultReg;
  }
}

async function compileAwaitExpression(node, context) {
  // Compile l'expression promise
  const promiseReg = await compileExpression(node.argument, context);

  // Créer un nouveau registre pour le résultat de l'attente
  const resultReg = newRegister(context);

  // Émettre le bytecode pour attendre la résolution de la promesse
  context.bytecode.push([OpCode.AWAIT, resultReg, promiseReg]);

  // Libérer le registre de la promesse après utilisation
  freeRegister(context, promiseReg);

  return resultReg; // Retourner le registre où le résultat est stocké
}

async function compileFunctionExpression(node, context) {
  // Create a new context for the function to manage its scope
  const functionContext = {
    bytecode: {
      length: 0,
      array: [],
      push: function (line) {
        this.array.push(line);
        this.length++;
      },
      join: function (separator) {
        return this.array.map(line => line.join(' ')).join(separator);
      },
    },
    scopeStack: [...context.scopeStack, new Map()],
    nextRegister: 0,
    labelCounter: 0,
    functions: new Map(),
    loopLabels: [],
    freeRegisters: [],
  };

  // Create a new register for the function itself
  const functionRegister = newRegister(context);

  // Emit bytecode to create a new function

  // set 
  context.bytecode.push([OpCode.FNEW, functionRegister, `F${context.functions.size}`]);

  // Register the function in the current context
  const functionName = node.id ? node.id.name : `anonymous_${context.labelCounter}`;

  context.functions.set(functionName, {
    name: functionName,
    startLine: node.loc.start.line,
    endLine: node.loc.end.line,
    bytecode: functionContext.bytecode,
  });

  // Add function parameters to the function's scope
  for (let i = 0; i < node.params.length; i++) {
    const param = node.params[i];
    if (param.type === 'Identifier') {
      const paramRegister = newRegister(functionContext);
      functionContext.scopeStack[0].set(param.name, paramRegister);
      // Assuming function arguments are passed in sequential registers
      functionContext.bytecode.push([OpCode.MOV, paramRegister, `ARG${i}`]);
    } else {
      throw new Error(`Unsupported parameter type: ${param.type}`);
    }
  }

  // Compile the function body
  await compileBlockStatement(node.body, functionContext);

  // Emit return opcode if the function doesn't have an explicit return
  if (!node.body.body.some(statement => statement.type === 'ReturnStatement')) {
    functionContext.bytecode.push([OpCode.RET]);
  }

  return functionRegister;
}

// Function to compile an expression
async function compileExpression(node, context) {
  switch (node.type) {
    case "Literal":
      return compileLiteral(node, context);
    case "Identifier":
      return resolveIdentifier(context, node.name);
    case "BinaryExpression":
      return await compileBinaryExpression(node, context);
    case "AssignmentExpression":
      return await compileAssignmentExpression(node, context);
    case "CallExpression":
      return await compileCallExpression(node, context);
    case "ArrayExpression":
      return await compileArrayExpression(node, context);
    case "MemberExpression":
      return await compileMemberExpression(node, context);
    case "UpdateExpression":
      return await compileUpdateExpression(node, context);
    case "ObjectExpression":
      return await compileObjectExpression(node, context);
    case "LogicalExpression":
      return await compileLogicalExpression(node, context);
    case "UnaryExpression":
      return await compileUnaryExpression(node, context);
    case "AwaitExpression":
      return await compileAwaitExpression(node, context);
    case "FunctionExpression":
      return await compileFunctionExpression(node, context);
    case "ArrowFunctionExpression":
      return await compileArrowFunctionExpression(node, context);
    default:
      console.log(require("util").inspect(node, false, null, true /* enable colors */));
      throw new Error(`Unsupported expression type: ${node.type}`);
  }
}

// Function to compile a literal
function compileLiteral(node, context) {
  const register = newRegister(context);
  if (typeof node.value === 'number') {
    context.bytecode.push([OpCode.LOAD, types.Number, register, node.value]);
  } else if (typeof node.value === 'bigint') {
    context.bytecode.push([OpCode.LOAD, types.Bigint, register, node.value]);
  } else if (typeof node.value === 'string') {
    context.bytecode.push([OpCode.LOAD, types.String, register, node.value]);
  } else if (typeof node.value === 'boolean') {
    const priValue = node.value ? 1 : 0; // true -> 1, false -> 0
    context.bytecode.push([OpCode.LOAD, types.Boolean, register, priValue]);
  } else if (node.value === null) {
    context.bytecode.push([OpCode.LOAD, types.Null, register, 0]);
  } else if (node.value === undefined) {
    context.bytecode.push([OpCode.LOAD, types.Undefined, register, 0]);
  } else {
    throw new Error(`Unsupported literal type: ${typeof node.value}`);
  }

  return register;
}

// Resolve an identifier by looking through scopes
function resolveIdentifier(context, name) {
  if (name === 'undefined') {
    // Handle `undefined` directly
    const register = newRegister(context);
    context.bytecode.push([OpCode.LOAD, types.Undefined, register, 0]);
    return register;
  }

  for (let i = context.scopeStack.length - 1; i >= 0; i--) {
    const scope = context.scopeStack[i];
    if (scope.has(name)) {
      return scope.get(name);
    }
  }

  // if the name start with $VM$ and end with $, it's a compiler instruction

  console.log("name", name);
  if (name.startsWith("$VM$") && name.endsWith("$")) {

    const instruction = name.slice(4, name.length - 1);

    console.log("instruction", instruction);
    switch (instruction) {
      case "EXIT":
        context.bytecode.push([OpCode.EXIT]);
        break;
      default:
        throw new Error(`Unsupported instruction: ${instruction}`);
    }

    return null;
  }

  const register = newRegister(context);
  const indexReg = newRegister(context);

  context.bytecode.push([OpCode.LOAD, types.String, indexReg, `"${name}"`]);
  context.bytecode.push([OpCode.GGETV, register, indexReg]);
  return register;

  throw new Error(`Identifier ${name} not found`);
}

// Function to compile a binary expression
async function compileBinaryExpression(node, context) {
  const leftReg = await compileExpression(node.left, context);
  const rightReg = await compileExpression(node.right, context);
  const resultReg = newRegister(context);

  switch (node.operator) {
    case '+':
      context.bytecode.push([OpCode.ADDVV, resultReg, leftReg, rightReg]);
      break;
    case '-':
      context.bytecode.push([OpCode.SUBVV, resultReg, leftReg, rightReg]);
      break;
    case '*':
      context.bytecode.push([OpCode.MULVV, resultReg, leftReg, rightReg]);
      break;
    case '/':
      context.bytecode.push([OpCode.DIVVV, resultReg, leftReg, rightReg]);
      break;
    case '&':
      context.bytecode.push([OpCode.BANDVV, resultReg, leftReg, rightReg]);
      break;
    case '|':
      context.bytecode.push([OpCode.BORVV, resultReg, leftReg, rightReg]);
      break;
    case '^':
      context.bytecode.push([OpCode.BXORVV, resultReg, leftReg, rightReg]);
      break;
    case '<<':
      context.bytecode.push([OpCode.LSHVV, resultReg, leftReg, rightReg]);
      break;
    case '>>':
      context.bytecode.push([OpCode.RSHVV, resultReg, leftReg, rightReg]);
      break;
    case '<<<':
      context.bytecode.push([OpCode.ULSHVV, resultReg, leftReg, rightReg]);
      break;
    case '>>>':
      context.bytecode.push([OpCode.URSHVV, resultReg, leftReg, rightReg]);
      break;
    case '<':
      context.bytecode.push([OpCode.ISLT, leftReg, rightReg]);
      break;
    case '>':
      context.bytecode.push([OpCode.ISGT, leftReg, rightReg]);
      break;
    case '<=':
      context.bytecode.push([OpCode.ISLE, leftReg, rightReg]);
      break;
    case '>=':
      context.bytecode.push([OpCode.ISGE, leftReg, rightReg]);
      break;
    case '===':
      context.bytecode.push([OpCode.ISEQV, leftReg, rightReg]);
      break;
    case '==':
      context.bytecode.push([OpCode.ISEQV, leftReg, rightReg]);
      break;
    case '!=':
      context.bytecode.push([OpCode.ISNEV, leftReg, rightReg]);
      break;
    case '!==':
      context.bytecode.push([OpCode.ISNEV, leftReg, rightReg]);
      break;
    case '%':
      context.bytecode.push([OpCode.MODVV, resultReg, leftReg, rightReg]);
      break;
    case '**':
      context.bytecode.push([OpCode.POWVV, resultReg, leftReg, rightReg]);
      break;
    default:
      throw new Error(`Unsupported binary operator: ${node.operator}`);
  }
  return resultReg;
}

// Fonction pour compiler une expression d'affectation
async function compileAssignmentExpression(node, context) {
  if (node.left.type === 'Identifier') {
    const destReg = resolveIdentifier(context, node.left.name);

    // Vérifie si le côté droit est une constante ou une variable
    if (node.right.type === 'Literal') {
      const literalReg = compileLiteral(node.right, context);
      context.bytecode.push([OpCode.MOV, destReg, literalReg]);
      freeRegister(context, literalReg); // Libérer le registre du littéral après utilisation
    } else if (node.right.type === 'Identifier') {
      const sourceReg = resolveIdentifier(context, node.right.name);
      context.bytecode.push([OpCode.MOV, destReg, sourceReg]);
    } else {
      const valueReg = await compileExpression(node.right, context);
      context.bytecode.push([OpCode.MOV, destReg, valueReg]);
      freeRegister(context, valueReg); // Libérer le registre de valeur après utilisation
    }

    return destReg;
  } else if (node.left.type === 'MemberExpression') {
    // Gérer l'affectation aux propriétés d'objet ou aux éléments de tableau
    return await compileMemberAssignmentExpression(node, context);
  } else if (node.left.type === 'ArrayPattern') {
    // Gérer l'affectation de déstructuration avec un motif de tableau
    return await compileArrayPatternAssignment(node, context);
  } else if (node.left.type === 'ObjectPattern') {
    // Gérer l'affectation de déstructuration avec un motif d'objet
    return await compileObjectPatternAssignment(node, context);
  } else {
    throw new Error(`Unsupported left-hand side in assignment: ${node.left.type}`);
  }
}

// Fonction pour compiler une affectation avec un motif de tableau
async function compileArrayPatternAssignment(node, context) {
  throw new Error("Not implemented yet");
}

// Fonction pour compiler une affectation avec un motif d'objet
async function compileObjectPatternAssignment(node, context) {
  // Compile l'expression du côté droit
  const sourceReg = await compileExpression(node.right, context);

  // Itère sur chaque propriété dans le motif d'objet
  for (const property of node.left.properties) {
    const key = property.key.name;
    const valueReg = newRegister(context);

    // Génère du bytecode pour extraire la valeur de la propriété de l'objet
    context.bytecode.push([OpCode.OGETV, valueReg, sourceReg, `"${key}"`]);

    // Gérer l'assignation par défaut
    if (property.value.type === 'AssignmentPattern') {
      const left = property.value.left;
      const right = property.value.right;

      if (left.type !== 'Identifier') {
        throw new Error(`Unsupported pattern element in object: ${left.type}`);
      }

      const varName = left.name;
      const varReg = getRegister(context, varName);

      // Génère du bytecode pour vérifier si la valeur est indéfinie et utiliser la valeur par défaut
      const defaultReg = await compileExpression(right, context);
      const isUndefinedReg = newRegister(context);

      context.bytecode.push([OpCode.ISNEV, isUndefinedReg, valueReg]);
      context.bytecode.push([OpCode.JMP, `L${context.labelCounter + 1}`, isUndefinedReg]);

      // Assigne la valeur à la variable
      context.bytecode.push([OpCode.MOV, varReg, valueReg]);
      context.bytecode.push([OpCode.JMP, `L${context.labelCounter + 2}`]);

      // Assigne la valeur par défaut
      context.bytecode.push([`L${context.labelCounter + 1}:`]);
      context.bytecode.push([OpCode.MOV, varReg, defaultReg]);

      // Fin de cette assignation
      context.bytecode.push([`L${context.labelCounter + 2}:`]);

      // Incrémente le compteur de labels
      context.labelCounter += 2;

      freeRegister(context, defaultReg);
      freeRegister(context, isUndefinedReg);
    } else if (property.value.type === 'Identifier') {
      const varName = property.value.name;
      const varReg = getRegister(context, varName);
      context.bytecode.push([OpCode.MOV, varReg, valueReg]);
    } else {
      throw new Error(`Unsupported pattern element in object: ${property.value.type}`);
    }

    // Libère le registre de la valeur après utilisation
    freeRegister(context, valueReg);
  }

  // Libère le registre source après la déstructuration
  freeRegister(context, sourceReg);
}

// Function to compile member assignment expressions
async function compileMemberAssignmentExpression(node, context) {
  const objectReg = await compileExpression(node.left.object, context);
  let propertyReg;

  // Determine if the property is computed or not
  if (node.left.computed) {
    propertyReg = await compileExpression(node.left.property, context);
  } else {
    propertyReg = newRegister(context);
    context.bytecode.push([OpCode.LOAD, types.String, propertyReg, `"${node.left.property.name}"`]);
  }

  const valueReg = await compileExpression(node.right, context);

  if (node.left.computed) {
    // For array elements (computed properties)
    context.bytecode.push([OpCode.ASETV, objectReg, propertyReg, valueReg]);
  } else {
    // For object properties (non-computed properties)
    context.bytecode.push([OpCode.OSETV, objectReg, propertyReg, valueReg]);
  }

  return valueReg;
}

// Function to compile an if statement
async function compileIfStatement(node, context) {
  const testReg = await compileExpression(node.test, context);

  const consequent = node.consequent;
  const alternate = node.alternate;

  const labelTrue = `L${++context.labelCounter}`;
  const labelEnd = `L${++context.labelCounter}`;

  context.bytecode.push([OpCode.JMP, labelTrue]);

  // Compile alternate (else) block
  if (alternate) {
    await compileStatement(alternate, context);
  }
  // Jump to end after alternate block
  context.bytecode.push([OpCode.JMP, labelEnd]);

  // Compile consequent (if) block
  context.bytecode.push([labelTrue + ':']);
  await compileStatement(consequent, context);

  context.bytecode.push([labelEnd + ':']);
}

// Function to compile a while statement
async function compileWhileStatement(node, context) {
  const labelStart = `L${++context.labelCounter}`;
  const labelEnd = `L${++context.labelCounter}`;

  // Push the current loop's labels onto the loopLabels stack
  context.loopLabels.push({ start: labelStart, end: labelEnd });

  // Label for the beginning of the loop
  context.bytecode.push([labelStart + ':']);

  // Evaluate the test condition
  const testReg = await compileExpression(node.test, context);
  context.bytecode.push([OpCode.JMP, labelEnd]);

  // Compile the loop body
  await compileStatement(node.body, context);

  // Jump back to the start of the loop
  context.bytecode.push([OpCode.JMP, labelStart]);

  // Label for the end of the loop
  context.bytecode.push([labelEnd + ':']);

  // Pop the current loop's labels off the loopLabels stack
  context.loopLabels.pop();
}

// Function to compile a function declaration
async function compileFunctionDeclaration(node, context) {
  // Create a new context for the function to manage its scope
  const functionContext = {
    bytecode: {
      length: 0,
      array: [],
      push: function (line) {
        this.array.push(line);
        this.length++;
      },
      join: function (separator) {
        return this.array.map(line => line.join(' ')).join(separator);
      },
    },
    scopeStack: [...context.scopeStack, new Map()],
    nextRegister: 0,
    labelCounter: 0,
    functions: new Map(),
    loopLabels: [],
    freeRegisters: [],
  };

  // Assign a new register for the function name in the current scope
  const functionName = node.id.name;
  const functionRegister = getRegister(context, functionName);

  // Emit bytecode to create a new function
  context.bytecode.push([OpCode.FNEW, functionRegister, `F${context.functions.size}`]);

  // Register the function in the main context
  context.functions.set(functionName, {
    name: functionName,
    startLine: node.loc.start.line,
    endLine: node.loc.end.line,
    bytecode: functionContext.bytecode,
  });

  // Add function parameters to the function's scope
  for (let i = 0; i < node.params.length; i++) {
    const param = node.params[i];
    if (param.type === 'Identifier') {
      const paramRegister = newRegister(functionContext);
      functionContext.scopeStack[0].set(param.name, paramRegister);
      // Assuming function arguments are passed in sequential registers
      functionContext.bytecode.push([OpCode.MOV, paramRegister, `ARG${i}`]);
    } else {
      throw new Error(`Unsupported parameter type: ${param.type}`);
    }
  }

  // Compile the function body
  await compileBlockStatement(node.body, functionContext);

  // Emit return opcode if the function doesn't have an explicit return
  if (!node.body.body.some(statement => statement.type === 'ReturnStatement')) {
    functionContext.bytecode.push([OpCode.RET]);
  }

  return functionRegister;
}

async function compileArrowFunctionExpression(node, context) {
  // Create a new context for the arrow function to manage its scope
  const functionContext = {
    bytecode: {
      length: 0,
      array: [],
      push: function (line) {
        this.array.push(line);
        this.length++;
      },
      join: function (separator) {
        return this.array.map(line => line.join(' ')).join(separator);
      },
    },
    scopeStack: [...context.scopeStack, new Map()],
    nextRegister: 0,
    labelCounter: 0,
    functions: new Map(),
    loopLabels: [],
    freeRegisters: [],
  };

  // Create a new register for the function
  const functionRegister = newRegister(context);

  // Emit bytecode to create a new function
  context.bytecode.push([OpCode.FNEW, functionRegister, `F${context.functions.size}`]);

  // Add function parameters to the function's scope
  for (let i = 0; i < node.params.length; i++) {
    const param = node.params[i];
    if (param.type === 'Identifier') {
      const paramRegister = newRegister(functionContext);
      functionContext.scopeStack[0].set(param.name, paramRegister);
      // Assuming function arguments are passed in sequential registers
      functionContext.bytecode.push([OpCode.MOV, paramRegister, `ARG${i}`]);
    } else {
      throw new Error(`Unsupported parameter type: ${param.type}`);
    }
  }

  // Handle concise body single expression arrow functions
  if (node.body.type !== 'BlockStatement') {
    const returnValue = await compileExpression(node.body, functionContext);
    functionContext.bytecode.push([OpCode.RET, returnValue]);
    freeRegister(functionContext, returnValue);
  } else {
    // Compile the function body if it's a block statement
    await compileBlockStatement(node.body, functionContext);

    // Emit return opcode if the function doesn't have an explicit return
    if (!node.body.body.some(statement => statement.type === 'ReturnStatement')) {
      functionContext.bytecode.push([OpCode.RET]);
    }
  }

  return functionRegister;
}

// Update the compileCallExpression function to handle function calls
async function compileCallExpression(node, context) {
  let funcRegister;

  if (node.callee.type === 'MemberExpression') {
    funcRegister = await compileMemberExpression(node.callee, context);
  } else {
    if (node.callee.name === 'undefined') {
      throw new Error(`Attempted to call undefined as a function`);
    }
    funcRegister = resolveIdentifier(context, node.callee.name);
  }

  const args = [];
  for (const arg of node.arguments) {
    args.push(await compileExpression(arg, context));
  }

  const numArgs = args.length;
  const numReturnValues = 1;
  const returnRegister = newRegister(context);

  context.bytecode.push([OpCode.CALL, funcRegister, numArgs, returnRegister]);

  args.forEach(argReg => freeRegister(context, argReg));

  return returnRegister;
}

// Example usage
(async () => {
  const testFolder = "./test/";
  const files = fs.readdirSync(testFolder);

  files.forEach(async (file) => {
    if (file === "script.js") {
      const data = fs.readFileSync(testFolder + file, "utf8");
      const bytecode = await compileProgram(data);

      console.log(`Bytecode for ${file}:`);
      console.log(bytecode.join('\n'));
    }
  });
})();
