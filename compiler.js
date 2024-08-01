const acorn = require('acorn');

// Enumeration for opcodes
const OpCode = {
  KNUM: 'KNUM',
  ADDVN: 'ADDVN',
  ADDNV: 'ADDNV',
  ADDVV: 'ADDVV',
  ADDNN: 'ADDNN',
  SUBVV: 'SUBVV',
  MULVV: 'MULVV',
  DIVVV: 'DIVVV',
  MOV: 'MOV',
  KSTR: 'KSTR',
  KPRI: 'KPRI',
  KNULL: 'KNULL',
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
  OGETV: 'OGETV'
};

function newRegister(context) {
  return `R${context.nextRegister++}`;
}

// Main function to compile a program
async function compileProgram(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  const context = {
    bytecode: {
      length: 0,
      array: [],
      push: function (line) {
        context.bytecode.array.push(context.bytecode.length + (context.bytecode.length < 10 ? " " : "") + " - " + line);
        context.bytecode.length++;
      },
      join: function (separator) {
        return context.bytecode.array.join(separator);
      }
    },
    scopeStack: [new Map()], // Stack of scopes with the global scope initialized
    nextRegister: 0,
    labelCounter: 0,
    functions: new Map(), // Map to store functions
    loopLabels: [] // Stack to manage loop labels for break statements
  };

  // Add console as a global object with log as a function
  context.scopeStack[0].set('print', console.log);

  await compileBlockStatement(ast, context);
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
  return currentScope.get(name);
}

// Function to compile a block of code
async function compileBlockStatement(node, context) {
  // Create a new scope for this block
  context.scopeStack.push(new Map());

  for (const statement of node.body) {
    await compileStatement(statement, context);
  }

  // Add GC instructions before exiting the current scope
  emitGCInstructions(context);

  // Exit the current scope
  context.scopeStack.pop();
}

// Function to emit GC instructions for the current scope
function emitGCInstructions(context) {
  const currentScope = context.scopeStack[context.scopeStack.length - 1];
  currentScope.forEach(register => {
    context.bytecode.push(`${OpCode.GC} ${register}`);
  });
}

// Function to compile a statement
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
      context.bytecode.push(`${OpCode.RET} ${returnValue}`);
      break;
    case 'IfStatement':
      await compileIfStatement(node, context);
      break;
    case 'WhileStatement':
      await compileWhileStatement(node, context);
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
    default:
      throw new Error(`Unsupported statement type: ${node.type}`);
  }
}

// Function to compile a break statement
function compileBreakStatement(node, context) {
  const labelEnd = context.loopLabels[context.loopLabels.length - 1].end;
  context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);
}

// Function to compile a variable declaration
async function compileVariableDeclaration(node, context) {
  for (const declaration of node.declarations) {
    const name = declaration.id.name;
    const destReg = getRegister(context, name);
    const value = await compileExpression(declaration.init, context);
    context.bytecode.push(`${OpCode.MOV} ${destReg}, ${value}`);
  }
}

// Function to compile an array expression
async function compileArrayExpression(node, context) {
  const register = newRegister(context); // Crée un nouveau registre pour le tableau

  // Crée un tableau vide et réserve un registre pour ce tableau
  context.bytecode.push(`${OpCode.ANEW} ${register}`);

  // Traite chaque élément du tableau et les assigne à des indices dans le tableau
  for (let i = 0; i < node.elements.length; i++) {
    const element = node.elements[i];
    const elementRegister = await compileExpression(element, context);
    context.bytecode.push(`${OpCode.ASETV} ${register}, ${i}, ${elementRegister}`);
  }

  // add the new register to the current scope
  const currentScope = context.scopeStack[context.scopeStack.length - 1];
  currentScope.set(register, register);

  return register; // Retourne le registre où le tableau est stocké
}

// Function to compile a member expression
async function compileMemberExpression(node, context) {
  const objectRegister = await compileExpression(node.object, context);

  let propertyRegister;
  if (node.computed) {
    // Pour les accès calculés, comme B[C]
    propertyRegister = await compileExpression(node.property, context);
  } else {
    // Pour les accès non calculés, comme B.C
    propertyRegister = newRegister(context);
    context.bytecode.push(`${OpCode.KSTR} ${propertyRegister}, "${node.property.name}"`);
  }

  const resultRegister = newRegister(context);

  if (node.computed) {
    // Si la propriété est un index calculé, nous accédons à un tableau
    context.bytecode.push(`${OpCode.AGETV} ${resultRegister}, ${objectRegister}, ${propertyRegister}`);
  } else {
    // Sinon, nous accédons à un objet
    context.bytecode.push(`${OpCode.OGETV} ${resultRegister}, ${objectRegister}, ${propertyRegister}`);
  }

  return resultRegister;
}

// Function to compile an expression
async function compileExpression(node, context) {
  switch (node.type) {
    case 'Literal':
      return compileLiteral(node, context);
    case 'Identifier':
      return resolveIdentifier(context, node.name);
    case 'BinaryExpression':
      return await compileBinaryExpression(node, context);
    case 'AssignmentExpression':
      return await compileAssignmentExpression(node, context);
    case 'CallExpression':
      console.log(require('util').inspect(node, false, null, true /* enable colors */));
      return await compileCallExpression(node, context);
    case 'ArrayExpression':
      return await compileArrayExpression(node, context);
    case 'MemberExpression':
      return await compileMemberExpression(node, context);
    default:
      throw new Error(`Unsupported expression type: ${node.type}`);
  }
}

// Function to compile a literal
function compileLiteral(node, context) {
  const register = newRegister(context);
  if (typeof node.value === 'number') {
    context.bytecode.push(`${OpCode.KNUM} ${register}, ${node.value}`);
  } else if (typeof node.value === 'string') {
    context.bytecode.push(`${OpCode.KSTR} ${register}, "${node.value}"`);
  } else if (typeof node.value === 'boolean') {
    const priValue = node.value ? 2 : 1; // true -> 2, false -> 1
    context.bytecode.push(`${OpCode.KPRI} ${register}, ${priValue}`);
  } else if (node.value === null) {
    context.bytecode.push(`${OpCode.KNULL} ${register}`);
  }

  // add the new register to the current scope
  const currentScope = context.scopeStack[context.scopeStack.length - 1];
  currentScope.set(register, register);
  return register;
}

// Resolve an identifier by looking through scopes
function resolveIdentifier(context, name) {
  for (let i = context.scopeStack.length - 1; i >= 0; i--) {
    const scope = context.scopeStack[i];
    if (scope.has(name)) {
      return scope.get(name);
    }
  }
  throw new Error(`Identifier ${name} not found`);
}

// Function to compile a binary expression
async function compileBinaryExpression(node, context) {
  const leftReg = await compileExpression(node.left, context);
  const rightReg = await compileExpression(node.right, context);
  const resultReg = newRegister(context);

  switch (node.operator) {
    case '+':
      context.bytecode.push(`${OpCode.ADDVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '-':
      context.bytecode.push(`${OpCode.SUBVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '*':
      context.bytecode.push(`${OpCode.MULVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '/':
      context.bytecode.push(`${OpCode.DIVVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '<':
      context.bytecode.push(`${OpCode.ISLT} , ${leftReg}, ${rightReg}`);
      break;
    case '>':
      context.bytecode.push(`${OpCode.ISGT} , ${leftReg}, ${rightReg}`);
      break;
    case '<=':
      context.bytecode.push(`${OpCode.ISLE} , ${leftReg}, ${rightReg}`);
      break;
    case '>=':
      context.bytecode.push(`${OpCode.ISGE} , ${leftReg}, ${rightReg}`);
      break;
    case '==':
      context.bytecode.push(`${OpCode.ISEQV} , ${leftReg}, ${rightReg}`);
      break;
    case '!=':
      context.bytecode.push(`${OpCode.ISNEV} , ${leftReg}, ${rightReg}`);
      break;
    default:
      throw new Error(`Unsupported binary operator: ${node.operator}`);
  }
  return resultReg;
}

// Function to compile an assignment expression
async function compileAssignmentExpression(node, context) {
  if (node.left.type !== 'Identifier') {
    throw new Error(`Unsupported left-hand side in assignment: ${node.left.type}`);
  }

  const destReg = resolveIdentifier(context, node.left.name);

  // Check if the right side is a constant or a variable
  if (node.right.type === 'Literal') {
    const literalReg = compileLiteral(node.right, context);
    context.bytecode.push(`${OpCode.MOV} ${destReg}, ${literalReg}`);
  } else if (node.right.type === 'Identifier') {
    const sourceReg = resolveIdentifier(context, node.right.name);
    context.bytecode.push(`${OpCode.MOV} ${destReg}, ${sourceReg}`);
  } else {
    const valueReg = await compileExpression(node.right, context);
    context.bytecode.push(`${OpCode.MOV} ${destReg}, ${valueReg}`);
  }

  return destReg;
}

// Function to compile an if statement
async function compileIfStatement(node, context) {
  const testReg = await compileExpression(node.test, context);
  const consequent = node.consequent;
  const alternate = node.alternate;

  const labelTrue = `L${++context.labelCounter}`;
  const labelEnd = `L${++context.labelCounter}`;

  context.bytecode.push(`${OpCode.JMP} ${labelTrue}`);

  // Compile alternate (else) block
  if (alternate) {
    await compileStatement(alternate, context);
  }
  // Jump to end after alternate block
  context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);

  // Compile consequent (if) block
  context.bytecode.push(`${labelTrue}:`);
  await compileStatement(consequent, context);

  context.bytecode.push(`${labelEnd}:`);
}

// Function to compile a while statement
async function compileWhileStatement(node, context) {
  const labelStart = `L${++context.labelCounter}`;
  const labelEnd = `L${++context.labelCounter}`;

  // Push the current loop's labels onto the loopLabels stack
  context.loopLabels.push({ start: labelStart, end: labelEnd });

  // Label for the beginning of the loop
  context.bytecode.push(`${labelStart}:`);

  // Evaluate the test condition
  const testReg = await compileExpression(node.test, context);
  context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);

  // Compile the loop body
  await compileStatement(node.body, context);

  // Jump back to the start of the loop
  context.bytecode.push(`${OpCode.JMP} ${labelStart}`);

  // Label for the end of the loop
  context.bytecode.push(`${labelEnd}:`);

  // Pop the current loop's labels off the loopLabels stack
  context.loopLabels.pop();
}

// Function to compile a function declaration
async function compileFunctionDeclaration(node, context) {
  const functionName = node.id.name;
  const functionRegister = getRegister(context, functionName);

  // Emit FNEW instruction to create a new function
  context.bytecode.push(`${OpCode.FNEW} ${functionRegister}`);

  // Create a new scope for the function parameters and body
  const functionScope = new Map();
  context.scopeStack.push(functionScope);

  // Push function parameters into the function scope
  let paramCount = 0;

  node.params.forEach(param => {
    const paramName = param.name;
    const paramRegister = getRegister(context, paramName);
    context.bytecode.push(`${OpCode.MOV} ${paramRegister}, ${paramCount++}`);
  });

  // Compile the body of the function
  await compileBlockStatement(node.body, context);

  // Add RET instruction to return from the function
  context.bytecode.push(`${OpCode.RET} 0`);

  // Exit the function scope
  context.scopeStack.pop();
}

// Update the compileCallExpression function to handle function calls
async function compileCallExpression(node, context) {
  const funcName = node.callee.name;
  const funcRegister = resolveIdentifier(context, funcName);

  // Prepare arguments
  const args = [];
  for (const arg of node.arguments) {
    args.push(await compileExpression(arg, context));
  }

  // Call the function
  context.bytecode.push(`${OpCode.CALL} ${funcRegister}, ${args.join(', ')}`);
}

// Example usage
(async () => {
  let code = `
    //let g = 1
    //let f = 1
    //
    //if (g == f) {
    //  let a = 1
    //} else if (g != 2) {
    //  let b = 3
    //} else {
    //  let c = 4
    //}

    for (let i = 0; i < 10; i++) {
      let a = 1
      let b = 2
    }
  `;

  const bytecode = await compileProgram(code);
  console.log(bytecode.join('\n'));
})();
