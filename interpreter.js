const acorn = require('acorn');

// Fonction pour évaluer les expressions
function evaluateExpression(node, context) {
    switch (node.type) {
        case 'Literal':
            return node.value;
        case 'Identifier':
            return context[node.name];
        case 'BinaryExpression':
            const left = evaluateExpression(node.left, context);
            const right = evaluateExpression(node.right, context);
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
            const callee = evaluateExpression(node.callee, context);
            const args = node.arguments.map(arg => evaluateExpression(arg, context));
            if (node.callee.type === 'MemberExpression') {
                const obj = evaluateExpression(node.callee.object, context);
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
            const object = evaluateExpression(node.object, context);
            const property = node.computed ? evaluateExpression(node.property, context) : node.property.name;
            return object[property];
        case 'ArrayExpression':
            return node.elements.map(element => evaluateExpression(element, context));
        case 'ObjectExpression':
            const obj = {};
            node.properties.forEach(prop => {
                const key = prop.key.type === 'Identifier' ? prop.key.name : evaluateExpression(prop.key, context);
                const value = evaluateExpression(prop.value, context);
                obj[key] = value;
            });
            return obj;
        case 'ArrowFunctionExpression':
            return (...args) => {
                const localContext = { ...context };
                node.params.forEach((param, index) => {
                    localContext[param.name] = args[index];
                });
                return node.body.type === 'BlockStatement' ? interpretBlockStatement(node.body, localContext) : evaluateExpression(node.body, localContext);
            };
        case 'AssignmentExpression':
            if (node.left.type === 'MemberExpression') {
                const obj = evaluateExpression(node.left.object, context);
                const prop = node.left.computed ? evaluateExpression(node.left.property, context) : node.left.property.name;
                const value = evaluateExpression(node.right, context);
                obj[prop] = value;
                return value;
            } else if (node.left.type === 'Identifier') {
                const value = evaluateExpression(node.right, context);
                context[node.left.name] = value;
                return value;
            }
            break;
        case 'UpdateExpression':
            if (node.argument.type === 'Identifier') {
                const argument = context[node.argument.name];
                if (node.operator === '++') {
                    return node.prefix ? ++context[node.argument.name] : context[node.argument.name]++;
                } else if (node.operator === '--') {
                    return node.prefix ? --context[node.argument.name] : context[node.argument.name]--;
                }
            }
            break;
        case 'ConditionalExpression':
            const test = evaluateExpression(node.test, context);
            return test ? evaluateExpression(node.consequent, context) : evaluateExpression(node.alternate, context);
        case 'BlockStatement':
            return interpretBlockStatement(node, context);
        default:
            throw new Error(`Unsupported expression type: ${node.type}`);
    }
}

// Fonction pour interpréter une déclaration de fonction
function interpretFunctionDeclaration(node, context) {
    const func = function (...args) {
        const localContext = { ...context };
        node.params.forEach((param, index) => {
            localContext[param.name] = args[index];
        });
        return interpretBlockStatement(node.body, localContext);
    };

    if (node.async) {
        context[node.id.name] = async function (...args) {
            return func(...args);
        }
    } else {
        context[node.id.name] = func;
    }
}

// Fonction pour interpréter une déclaration de variable
function interpretVariableDeclaration(node, context) {
    node.declarations.forEach(declaration => {
        const name = declaration.id.name;
        const value = evaluateExpression(declaration.init, context);
        context[name] = value;
    });
}

// Fonction pour interpréter un bloc de code
function interpretBlockStatement(node, context) {
    let result;
    for (const statement of node.body) {
        result = interpretStatement(statement, context);
        if (statement.type === 'ReturnStatement') {
            return result;
        }
    }
    return result;
}

// Fonction pour interpréter une instruction
function interpretStatement(node, context) {
    switch (node.type) {
        case 'FunctionDeclaration':
            interpretFunctionDeclaration(node, context);
            break;
        case 'VariableDeclaration':
            interpretVariableDeclaration(node, context);
            break;
        case 'ExpressionStatement':
            evaluateExpression(node.expression, context);
            break;
        case 'ReturnStatement':
            return evaluateExpression(node.argument, context);
        case 'ForStatement':
            interpretForStatement(node, context);
            break;
        case 'BlockStatement':
            return interpretBlockStatement(node, context);
        case 'IfStatement':
            const test = evaluateExpression(node.test, context);
            if (test) {
                return interpretStatement(node.consequent, context);
            } else if (node.alternate) {
                return interpretStatement(node.alternate, context);
            }
            break;
        case 'AwaitExpression':
                //const argument = await evaluateExpression(node.argument, context);
                //return await argument;
        default:
            throw new Error(`Unsupported statement type: ${node.type}`);
    }
}

// Fonction pour interpréter une boucle for
function interpretForStatement(node, context) {
    if (node.init) {
        interpretStatement(node.init, context);
    }
    while (evaluateExpression(node.test, context)) {
        interpretBlockStatement(node.body, context);
        if (node.update) {
            evaluateExpression(node.update, context);
        }
    }
}

// Fonction principale pour interpréter un programme
function interpretProgram(code, context = {}) {
    const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    return interpretBlockStatement(ast, context);
}

module.exports = { interpretProgram, interpretBlockStatement };
