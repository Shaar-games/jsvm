const acorn = require('acorn');
const fs = require('fs');
// Enumeration for opcodes
const OpCode = {
  ADDVN: 'ADDVN',
  ADDNV: 'ADDNV',
  ADDVV: 'ADDVV',
  ADDNN: 'ADDNN',
  SUBVV: 'SUBVV',
  MULVV: 'MULVV',
  DIVVV: 'DIVVV',
  MOV: 'MOV',
  KNUM: 'KNUM',
  KBIG: 'KBIG',
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
  GGET: 'GGET',
  GSET: 'GSET',
};

function newRegister(context) {

  // print the used registers

  console.log(context.freeRegisters);
  
  if (context.freeRegisters.length > 0) {
    // Reuse a register from the free pool
    return context.freeRegisters.pop();
  } else {
    // Allocate a new register
    context.nextRegister = context.nextRegister + 1;
    const r = `R${context.nextRegister}`
    return r;
  }
}

function freeRegister(context, register) {
  //context.bytecode.push(`${OpCode.GC} ${register}`);
  context.freeRegisters.push(register);
}

function pushFunction(name, func, context) {
  context.globalTable.set(name, func);
}

// Function to push a global object into the global table
function pushGlobal(name, value, context) {
  context.globalTable.set(name, value);
}

async function compileProgram(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });

  console.log(require("util").inspect(ast, false, null, true /* enable colors */));

  const context = {
    bytecode: {
      length: 0,
      array: [],
      push: function (line) {
        context.bytecode.array.push(
          context.bytecode.length + (context.bytecode.length < 10 ? " " : "") + " - " + line
        );
        context.bytecode.length++;
      },
      join: function (separator) {
        return context.bytecode.array.join(separator);
      },
    },
    scopeStack: [new Map()], // Stack of scopes with the global scope initialized
    nextRegister: 0,
    labelCounter: 0,
    functions: new Map(), // Map to store functions
    loopLabels: [], // Stack to manage loop labels for break statements
    freeRegisters: [], // Pool of free registers
    globalTable: new Map(), // Global table to store global variables
  };

  // Add console as a global object with log as a function
  pushGlobal("console", console, context);
  pushFunction("log", console.log, context);

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

// Function to compile a for statement
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
  context.bytecode.push(`${labelStart}:`);

  // Compile test condition
  if (node.test) {
    const testReg = await compileExpression(node.test, context);
    // If the test fails, jump to the end
    context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);
  }

  // Compile the loop body
  await compileStatement(node.body, context);

  // Compile update expression
  if (node.update) {
    await compileExpression(node.update, context);
  }

  // Jump back to the start of the loop
  context.bytecode.push(`${OpCode.JMP} ${labelStart}`);

  // Label for the end of the loop
  context.bytecode.push(`${labelEnd}:`);

  // Pop the current loop's labels off the loopLabels stack
  context.loopLabels.pop();
}

// Function to emit GC instructions for the current scope
function emitGCInstructions(context) {
  const currentScope = context.scopeStack[context.scopeStack.length - 1];
  currentScope.forEach(register => {
    //context.bytecode.push(`${OpCode.GC} ${register}`);
    // check if the register is in the free pool
    if (!context.freeRegisters.includes(register)) {
      // Remove the register from the free pool
      
      //const index = context.freeRegisters.indexOf(register);
      //context.freeRegisters.splice(index, 1);
      
      freeRegister(context, register); // Mark the register as reusable
    }
   
  });
}

async function compileForOfStatement(node, context) {
  const iterableReg = await compileExpression(node.right, context); // Compile the iterable expression
  const iteratorReg = newRegister(context); // Register for the iterator
  const resultReg = newRegister(context);   // Register for the current iteration result
  const doneReg = newRegister(context);     // Register to check if the iteration is done

  // Get the iterator from the iterable
  context.bytecode.push(`${OpCode.CALL} ${iteratorReg}, ${iterableReg}[Symbol.iterator]`);

  const labelStart = `L${++context.labelCounter}`; // Start of the loop
  const labelEnd = `L${++context.labelCounter}`;   // End of the loop

  context.bytecode.push(`${labelStart}:`);

  // Get the next value from the iterator
  context.bytecode.push(`${OpCode.CALL} ${resultReg}, ${iteratorReg}.next`);

  // Check if the iteration is done
  context.bytecode.push(`${OpCode.MOV} ${doneReg}, ${resultReg}.done`);
  context.bytecode.push(`${OpCode.ISNEV} , ${doneReg}, true`);
  context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);

  // Extract the value from the iteration result
  const valueReg = newRegister(context);
  context.bytecode.push(`${OpCode.MOV} ${valueReg}, ${resultReg}.value`);

  // Handle variable declaration or assignment
  if (node.left.type === 'VariableDeclaration') {
    // Only support `let` and `const` for now
    const declaration = node.left.declarations[0];
    const varName = declaration.id.name;
    const varReg = getRegister(context, varName);
    context.bytecode.push(`${OpCode.MOV} ${varReg}, ${valueReg}`);
  } else if (node.left.type === 'Identifier') {
    const varReg = resolveIdentifier(context, node.left.name);
    context.bytecode.push(`${OpCode.MOV} ${varReg}, ${valueReg}`);
  } else {
    throw new Error(`Unsupported left-hand side in for-of: ${node.left.type}`);
  }

  // Compile the loop body
  await compileStatement(node.body, context);

  // Jump back to the start of the loop
  context.bytecode.push(`${OpCode.JMP} ${labelStart}`);

  // Label for the end of the loop
  context.bytecode.push(`${labelEnd}:`);
}

// Function to compile a continue statement
function compileContinueStatement(node, context) {
  if (context.loopLabels.length === 0) {
    throw new Error(`'continue' used outside of a loop`);
  }

  // Get the current loop's start label
  const labelStart = context.loopLabels[context.loopLabels.length - 1].start;

  // Emit jump to the start of the loop
  context.bytecode.push(`${OpCode.JMP} ${labelStart}`);
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
      context.bytecode.push(`${OpCode.RET} ${returnValue}`);
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
  context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);
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
      throw new Error("Computed properties in object pattern not supported.");
    }

    // Generate bytecode to extract the property value from the object
    context.bytecode.push(`${OpCode.OGETV} ${valueReg}, ${sourceReg}, "${key}"`);

    // Assign the extracted value to the variable name in the pattern
    if (property.value.type === 'Identifier') {
      const varName = property.value.name;
      const varReg = getRegister(context, varName);
      context.bytecode.push(`${OpCode.MOV} ${varReg}, ${valueReg}`);
    } else {
      throw new Error(`Unsupported pattern element: ${property.value.type}`);
    }

    // Free the value register after use
    freeRegister(context, valueReg);
  }

  // Free the source register after destructuring
  freeRegister(context, sourceReg);
}

// Function to compile array pattern (destructuring assignment)
async function compileArrayPattern(declaration, context) {
  // Compile the right-hand side expression (the array to destructure)
  const sourceReg = await compileExpression(declaration.init, context);

  // Iterate over each element in the array pattern
  for (let index = 0; index < declaration.id.elements.length; index++) {
    const element = declaration.id.elements[index];
    const valueReg = newRegister(context);

    // Generate bytecode to extract the element from the array
    context.bytecode.push(`${OpCode.AGETV} ${valueReg}, ${sourceReg}, ${index}`);

    // Assign the extracted value to the variable name in the pattern
    if (element.type === 'Identifier') {
      const varName = element.name;
      const varReg = getRegister(context, varName);
      context.bytecode.push(`${OpCode.MOV} ${varReg}, ${valueReg}`);
    } else {
      throw new Error(`Unsupported pattern element: ${element.type}`);
    }

    // Free the value register after use
    freeRegister(context, valueReg);
  }

  // Free the source register after destructuring
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
      console.log("declaration", declaration.id.type)
      // Regular variable declaration
      const name = declaration.id.name;
      const value = await compileExpression(declaration.init, context);
      const destReg = getRegister(context, name);
      context.bytecode.push(`${OpCode.MOV} ${destReg}, ${value}`);
      freeRegister(context, value);
    }else{
      throw new Error(`Unsupported declaration type: ${declaration.id.type}`);
    }
  }
}

// Function to compile an array expression
async function compileArrayExpression(node, context) {
  //throw new Error("Not implemented yet");
  const register = newRegister(context);
  // Crée un tableau vide et réserve un registre pour ce tableau
  context.bytecode.push(`${OpCode.ANEW} ${register}`);

  // Traite chaque élément du tableau et les assigne à des indices dans le tableau
  for (let i = 0; i < node.elements.length; i++) {
    const element = node.elements[i];
    const elementRegister = await compileExpression(element, context);
    context.bytecode.push(`${OpCode.ASETV} ${register}, ${i}, ${elementRegister}`);
    // Libère le registre de l'élément après utilisation
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
  context.bytecode.push(`${OpCode.KNUM} ${oneReg}, 1`);

  // Apply the operation and update the register
  context.bytecode.push(`${opcode} ${argReg}, ${argReg}, ${oneReg}`);

  // If the expression is a prefix operation, return the updated value
  if (node.prefix) {
    return argReg;
  } else {
    // For postfix, create a temporary register to store the original value
    const tempReg = newRegister(context);
    context.bytecode.push(`${OpCode.MOV} ${tempReg}, ${argReg}`);
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
    context.bytecode.push(`${OpCode.KSTR} ${propertyRegister}, "${node.property.name}"`);
  }

  const resultRegister = newRegister(context);

  if (node.computed) {
    // If the property is an index, access it as an array
    context.bytecode.push(`${OpCode.AGETV} ${resultRegister}, ${objectRegister}, ${propertyRegister}`);
  } else {
    // Otherwise, access it as an object property
    context.bytecode.push(`${OpCode.OGETV} ${resultRegister}, ${objectRegister}, ${propertyRegister}`);
  }

  return resultRegister;
}


async function compileObjectExpression(node, context) {
  const objectRegister = newRegister(context); // Create a new register for the object

  // Emit instruction to create a new object
  context.bytecode.push(`${OpCode.ONEW} ${objectRegister}`); // Reuse ANEW opcode for object creation

  for (const property of node.properties) {
    // Compile the property value
    const valueRegister = await compileExpression(property.value, context);

    // Handle computed and non-computed keys
    let keyRegister;
    if (property.computed) {
      keyRegister = await compileExpression(property.key, context);
    } else {
      keyRegister = newRegister(context);
      context.bytecode.push(`${OpCode.KSTR} ${keyRegister}, "${property.key.name || property.key.value}"`);
    }

    // Assign the value to the object using the key
    context.bytecode.push(`${OpCode.OGETV} ${objectRegister}, ${keyRegister}, ${valueRegister}`);
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
    context.bytecode.push(`${OpCode.ISFC} ${leftReg}, ${labelRightEval}`);
    context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);
  } else if (node.operator === '||') {
    // For '||', if the left is true, jump to the end
    context.bytecode.push(`${OpCode.ISTC} ${leftReg}, ${labelRightEval}`);
    context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);
  } else {
    throw new Error(`Unsupported logical operator: ${node.operator}`);
  }

  // Label to evaluate the right operand
  context.bytecode.push(`${labelRightEval}:`);
  const rightReg = await compileExpression(node.right, context);
  context.bytecode.push(`${OpCode.MOV} ${resultReg}, ${rightReg}`);
  context.bytecode.push(`${OpCode.JMP} ${labelEnd}`);

  // Label for the end of the expression
  context.bytecode.push(`${labelEnd}:`);
  context.bytecode.push(`${OpCode.MOV} ${resultReg}, ${leftReg}`);

  return resultReg;
}

async function compileUnaryExpression(node, context) {
  const resultReg = newRegister(context);

  if (node.operator === "delete") {
    if (node.argument.type === "MemberExpression") {
      throw new Error(`Unsupported argument for 'delete': ${node.argument.type}`);
    } else if (node.argument.type === "Identifier") {
      // For deleting a variable, set it to null and perform GC
      const varReg = resolveIdentifier(context, node.argument.name);
      const nullReg = newRegister(context);
      context.bytecode.push(`${OpCode.KNULL} ${nullReg}`);
      context.bytecode.push(`${OpCode.MOV} ${varReg}, ${nullReg}`);
      //context.bytecode.push(`${OpCode.GC} ${varReg}`);

      // Set the result register to indicate success
      context.bytecode.push(`${OpCode.KPRI} ${resultReg}, 1`);

      // Free the null register
      //freeRegister(context, nullReg);
    } else {
      throw new Error(`Unsupported argument for 'delete': ${node.argument.type}`);
    }

    return resultReg;
  } else {
    const argReg = await compileExpression(node.argument, context);

    switch (node.operator) {
      case "-":
        // Unary minus: Set result to negative of the argument
        context.bytecode.push(`${OpCode.UNM} ${resultReg}, ${argReg}`);
        break;
      case "!":
        // Logical NOT: Set result to boolean not of the argument
        context.bytecode.push(`${OpCode.NOT} ${resultReg}, ${argReg}`);
        break;
      case "+":
        // Unary plus: Simply copy the argument to the result
        context.bytecode.push(`${OpCode.MOV} ${resultReg}, ${argReg}`);
        break;
      case "~":
        // Bitwise NOT: Typically requires XOR with -1
        const allOnesReg = newRegister(context);
        context.bytecode.push(`${OpCode.MOV} ${allOnesReg}, -1`);
        context.bytecode.push(`${OpCode.XOR} ${resultReg}, ${argReg}, ${allOnesReg}`);
        //freeRegister(context, allOnesReg);
        break;
      default:
        throw new Error(`Unsupported unary operator: ${node.operator}`);
    }

    //freeRegister(context, argReg);
    return resultReg;
  }
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
    default:
      console.log(require("util").inspect(node, false, null, true /* enable colors */));
      throw new Error(`Unsupported expression type: ${node.type}`);
  }
}

// Function to compile a literal
// Function to compile a literal
function compileLiteral(node, context) {
  const register = newRegister(context);
  if (typeof node.value === 'number') {
    context.bytecode.push(`${OpCode.KNUM} ${register}, ${node.value}`);
  } else if (typeof node.value === 'bigint') {
    context.bytecode.push(`${OpCode.KBIG} ${register}, ${node.value}`);
  } else if (typeof node.value === 'string') {
    context.bytecode.push(`${OpCode.KSTR} ${register}, "${node.value}"`);
  } else if (typeof node.value === 'boolean') {
    const priValue = node.value ? 1 : 0; // true -> 1, false -> 0
    context.bytecode.push(`${OpCode.KPRI} ${register}, ${priValue}`);
  } else if (node.value === null) {
    context.bytecode.push(`${OpCode.KNULL} ${register}`);
  } else if (node.value === undefined) {
    // Handle `undefined` as a special literal case
    context.bytecode.push(`${OpCode.KNULL} ${register}`); // Assuming `undefined` can be treated like `null`
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
    context.bytecode.push(`${OpCode.KNULL} ${register}`); // Treat undefined similar to null
    return register;
  }

  for (let i = context.scopeStack.length - 1; i >= 0; i--) {
    const scope = context.scopeStack[i];
    if (scope.has(name)) {
      return scope.get(name);
    }
  }

  // If the identifier is not found, search in the global table
  if (context.globalTable.has(name)) {
    const globalEntry = context.globalTable.get(name);
    if (typeof globalEntry === 'function' || typeof globalEntry === 'object') {
      const register = newRegister(context);
      context.bytecode.push(`${OpCode.GGET} ${register}, "${name}"`);
      return register;
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
    case '&':
      context.bytecode.push(`${OpCode.BANDVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '|':
      context.bytecode.push(`${OpCode.BORVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '^':
      context.bytecode.push(`${OpCode.BXORVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '<<':
      context.bytecode.push(`${OpCode.LSHVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '>>':
      context.bytecode.push(`${OpCode.RSHVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '<<<':
      context.bytecode.push(`${OpCode.ULSHVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '>>>':
      context.bytecode.push(`${OpCode.URSHVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '<':
      context.bytecode.push(`${OpCode.ISLT} ${leftReg}, ${rightReg}`);
      break;
    case '>':
      context.bytecode.push(`${OpCode.ISGT} ${leftReg}, ${rightReg}`);
      break;
    case '<=':
      context.bytecode.push(`${OpCode.ISLE} ${leftReg}, ${rightReg}`);
      break;
    case '>=':
      context.bytecode.push(`${OpCode.ISGE} ${leftReg}, ${rightReg}`);
      break;
    case '===':
      context.bytecode.push(`${OpCode.ISEQV} , ${leftReg}, ${rightReg}`); // voir si c'est bien ISEQV
      break;
    case '==':
      context.bytecode.push(`${OpCode.ISEQV} , ${leftReg}, ${rightReg}`);
      break;
    case '!=':
      context.bytecode.push(`${OpCode.ISNEV} , ${leftReg}, ${rightReg}`);
      break;
    case '!==':
      context.bytecode.push(`${OpCode.ISNEV} , ${leftReg}, ${rightReg}`); // voir si c'est bien ISNEV
      break;
    case '%':
      context.bytecode.push(`${OpCode.MODVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    case '**':
      context.bytecode.push(`${OpCode.POWVV} ${resultReg}, ${leftReg}, ${rightReg}`);
      break;
    default:
      throw new Error(`Unsupported binary operator: ${node.operator}`);
  }
  return resultReg;
}

async function compileAssignmentExpression(node, context) {

  console.log("type", node.left.type)

  if (node.left.type === 'Identifier') {
    const destReg = resolveIdentifier(context, node.left.name);

    // Check if the right side is a constant or a variable
    if (node.right.type === 'Literal') {
      const literalReg = compileLiteral(node.right, context);
      context.bytecode.push(`${OpCode.MOV} ${destReg}, ${literalReg}`);
      //freeRegister(context, literalReg); // Free the literal register after use
    } else if (node.right.type === 'Identifier') {
      const sourceReg = resolveIdentifier(context, node.right.name);
      context.bytecode.push(`${OpCode.MOV} ${destReg}, ${sourceReg}`);

    } else {
      
      const valueReg = await compileExpression(node.right, context);
      context.bytecode.push(`${OpCode.MOV} ${destReg}, ${valueReg}`);
      //freeRegister(context, valueReg); // Free the value register after use
    }

    return destReg;
  } else if (node.left.type === 'MemberExpression') {
    // Handle assignment to object properties or array elements
    return await compileMemberAssignmentExpression(node, context);
  } else {
    throw new Error(`Unsupported left-hand side in assignment: ${node.left.type}`);
  }
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
    context.bytecode.push(`${OpCode.KSTR} ${propertyReg}, "${node.left.property.name}"`);
  }

  const valueReg = await compileExpression(node.right, context);

  if (node.left.computed) {
    // For array elements (computed properties)
    context.bytecode.push(`${OpCode.ASETV} ${objectReg}, ${propertyReg}, ${valueReg}`);
  } else {
    // For object properties (non-computed properties)
    context.bytecode.push(`${OpCode.OSETV} ${objectReg}, ${propertyReg}, ${valueReg}`);
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
  const functionName = node.id.name; // Get the name of the function
  const functionRegister = getRegister(context, functionName); // Get a register for the function

  // Generate unique labels for the start and end of the function
  const functionStartLabel = `FUNC_START_${functionName}`;
  const functionEndLabel = `FUNC_END_${functionName}`;

  // Emit label for the start of the function
  context.bytecode.push(`${functionStartLabel}:`);

  // Emit FNEW instruction to create a new function
  context.bytecode.push(`${OpCode.FNEW} ${functionRegister}`);

  // Create a new scope for the function parameters and body
  const functionScope = new Map();
  context.scopeStack.push(functionScope);

  // Assign function parameters to registers
  let paramCount = 0;
  for (const param of node.params) {
    const paramName = param.name;
    const paramRegister = getRegister(context, paramName);
    context.bytecode.push(`${OpCode.MOV} ${paramRegister}, ${paramCount++}`);
  }

  // Compile the body of the function
  await compileBlockStatement(node.body, context);

  // Add RET instruction to return from the function
  //context.bytecode.push(`${OpCode.RET} 0`);

  // Emit label for the end of the function
  context.bytecode.push(`${functionEndLabel}:`);

  // Exit the function scope
  context.scopeStack.pop();

  // Optionally, store function information in the context for logging or debugging
  context.functions.set(functionName, { register: functionRegister, startLabel: functionStartLabel, endLabel: functionEndLabel });

  console.log(`Function ${functionName} compiled with labels: ${functionStartLabel}, ${functionEndLabel}`);
}

// Update the compileCallExpression function to handle function calls
// Function to compile a call expression
// Function to compile a call expression
async function compileCallExpression(node, context) {
  let funcRegister;

  if (node.callee.type === 'MemberExpression') {
    // Handle member expressions, e.g., console.log
    funcRegister = await compileMemberExpression(node.callee, context);
  } else {
    // Handle normal identifiers
    if (node.callee.name === 'undefined') {
      throw new Error(`Attempted to call undefined as a function`);
    }
    funcRegister = resolveIdentifier(context, node.callee.name);
  }

  // Prepare arguments
  const args = [];
  for (const arg of node.arguments) {
    args.push(await compileExpression(arg, context));
  }

  // Number of arguments
  const numArgs = args.length;

  // Emit the CALL instruction with the number of return values and arguments
  const numReturnValues = 1; // Assuming one return value for simplicity
  const returnRegister = newRegister(context);

  context.bytecode.push(`${OpCode.CALL} ${funcRegister}, ${numArgs}, ${returnRegister}`);

  args.forEach(argReg => freeRegister(context, argReg));

  return returnRegister;
}


// Example usage
(async () => {

  const testFolder = "./test/";
  const files = fs.readdirSync(testFolder);

  files.forEach(async (file) => {
    if (file === "registery.js") {
      const data = fs.readFileSync(testFolder + file, "utf8");
      const bytecode = await compileProgram(data);
    
      console.log(`Bytecode for ${file}:`);
      console.log(bytecode.join('\n'));
    }
  });
})();
