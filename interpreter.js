const acorn = require('acorn');

// Fonction pour évaluer les expressions
async function evaluateExpression(node, context) {
    switch (node.type) {
        case 'Literal':
            return node.value;
        case 'Identifier':
            return context[node.name];
        case 'BinaryExpression':
            const left = await evaluateExpression(node.left, context);
            const right = await evaluateExpression(node.right, context);
            switch (node.operator) {
                case '+':
                    return left + right;
                case '-':
                    return left - right;
                case '*':
                    return left * right;
                case '/':
                    return left / right;
                case '<':
                    return left < right;
                case '>':
                    return left > right;
                case '<=':
                    return left <= right;
                case '>=':
                    return left >= right;
                case '==':
                    return left == right;
                case '===':
                    return left === right;
                case '!=':
                    return left != right;
                case '!==':
                    return left !== right;
            }
            break;
        case 'CallExpression':
            const callee = await evaluateExpression(node.callee, context);
            const args = await Promise.all(node.arguments.map(arg => evaluateExpression(arg, context)));
            if (node.callee.type === 'MemberExpression') {
                const obj = await evaluateExpression(node.callee.object, context);
                const method = node.callee.property.name;
                if (typeof obj[method] === 'function') {
                    return obj[method](...args);
                } else {
                    throw new Error(`Called object does not have method: ${method}`);
                }
            } else {
                if (typeof callee === 'function') {
                    return callee(...args);
                } else {
                    throw new Error(`Called object is not a function: ${callee}`);
                }
            }
        case 'MemberExpression':
            const object = await evaluateExpression(node.object, context);
            const property = node.computed ? await evaluateExpression(node.property, context) : node.property.name;
            return object[property];
        case 'ArrayExpression':
            return Promise.all(node.elements.map(element => evaluateExpression(element, context)));
        case 'ObjectExpression':
            const obj = {};
            for (const prop of node.properties) {
                const key = prop.key.type === 'Identifier' ? prop.key.name : await evaluateExpression(prop.key, context);
                const value = await evaluateExpression(prop.value, context);
                obj[key] = value;
            }
            return obj;
        case 'ArrowFunctionExpression':
            return async (...args) => {
                const localContext = { ...context };
                node.params.forEach((param, index) => {
                    localContext[param.name] = args[index];
                });
                return node.body.type === 'BlockStatement' ? await interpretBlockStatement(node.body, localContext) : await evaluateExpression(node.body, localContext);
            };
        case 'AssignmentExpression':
            if (node.left.type === 'MemberExpression') {
                const obj = await evaluateExpression(node.left.object, context);
                const prop = node.left.computed ? await evaluateExpression(node.left.property, context) : node.left.property.name;
                const value = await evaluateExpression(node.right, context);
                obj[prop] = value;
                return value;
            } else if (node.left.type === 'Identifier') {
                const value = await evaluateExpression(node.right, context);
                context[node.left.name] = value;
                return value;
            }
            break;
        case 'UpdateExpression':
            if (node.argument.type === 'Identifier') {
                if (node.operator === '++') {
                    return node.prefix ? ++context[node.argument.name] : context[node.argument.name]++;
                } else if (node.operator === '--') {
                    return node.prefix ? --context[node.argument.name] : context[node.argument.name]--;
                }
            }
            break;
        case 'ConditionalExpression':
            const test = await evaluateExpression(node.test, context);
            return test ? await evaluateExpression(node.consequent, context) : await evaluateExpression(node.alternate, context);
        case 'BlockStatement':
            return interpretBlockStatement(node, context);
        case 'AwaitExpression':
            const argument = await evaluateExpression(node.argument, context);
            return await argument;
        default:
            throw new Error(`Unsupported expression type: ${node.type}`);
    }
}

// Fonction pour interpréter une déclaration de fonction
async function interpretFunctionDeclaration(node, context) {
    const func = async function (...args) {
        const localContext = { ...context };
        node.params.forEach((param, index) => {
            localContext[param.name] = args[index];
        });
        return await interpretBlockStatement(node.body, localContext);
    };

    if (node.async) {
        context[node.id.name] = async function (...args) {
            return await func(...args);
        };
    } else {
        context[node.id.name] = func;
    }
}

// Fonction pour interpréter une déclaration de variable
async function interpretVariableDeclaration(node, context) {
    for (const declaration of node.declarations) {
        const name = declaration.id.name;
        const value = await evaluateExpression(declaration.init, context);
        context[name] = value;
    }
}

// Fonction pour interpréter un bloc de code
async function interpretBlockStatement(node, context) {
    let result;
    for (const statement of node.body) {
        result = await interpretStatement(statement, context);
        if (statement.type === 'ReturnStatement') {
            return result;
        }
    }
    return result;
}

// Fonction pour interpréter une instruction
async function interpretStatement(node, context) {
    switch (node.type) {
        case 'FunctionDeclaration':
            await interpretFunctionDeclaration(node, context);
            break;
        case 'VariableDeclaration':
            await interpretVariableDeclaration(node, context);
            break;
        case 'ExpressionStatement':
            await evaluateExpression(node.expression, context);
            break;
        case 'ReturnStatement':
            return await evaluateExpression(node.argument, context);
        case 'ForStatement':
            await interpretForStatement(node, context);
            break;
        case 'BlockStatement':
            return await interpretBlockStatement(node, context);
        case 'IfStatement':
            const test = await evaluateExpression(node.test, context);
            if (test) {
                return await interpretStatement(node.consequent, context);
            } else if (node.alternate) {
                return await interpretStatement(node.alternate, context);
            }
            break;
        case 'AwaitExpression':
            const argument = await evaluateExpression(node.argument, context);
            return await argument;
        default:
            throw new Error(`Unsupported statement type: ${node.type}`);
    }
}

// Fonction pour interpréter une boucle for
async function interpretForStatement(node, context) {
    if (node.init) {
        await interpretStatement(node.init, context);
    }
    while (await evaluateExpression(node.test, context)) {
        await interpretBlockStatement(node.body, context);
        if (node.update) {
            await evaluateExpression(node.update, context);
        }
    }
}

// Fonction principale pour interpréter un programme
async function interpretProgram(code, context = {}) {
    const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    return await interpretBlockStatement(ast, context);
}

module.exports = { interpretProgram, interpretBlockStatement };
