import {DocumentNode, FieldNode, FragmentDefinitionNode, OperationDefinitionNode, parse} from "graphql";
import {ArgumentNode, SelectionNode, SelectionSetNode} from "graphql/language/ast";

type Name = string
type Result = Promise<{ value?: any, errors?: any }>

interface Node {
    kind: Name;
    kinds: Set<Name>;

    evaluate(selection: Selection): Result;
}

function any<Kind>(self: Set<Kind>) {
    return {
        in(other: Set<Kind>) {
            for (let value of self.values()) {
                if (other.has(value)) return true;
            }
            return false;
        }
    }
}

class ObjectNode implements Node {
    kind: Name;
    kinds: Set<Name>;

    constructor(kind: Name, parents?: Node[]) {
        this.kind = kind;
        this.kinds = new Set<Name>(kind);
        if (parents != undefined) {
            for (let parent of parents.values()) {
                for (let kind of parent.kinds) {
                    this.kinds.add(kind);
                }
            }
        }
    }

    evaluate(selection: Selection): Result {
        return new Promise((resolve, reject) => {
            const incomingFields = [];

            selection.forEach((field) => {
                if (field.onKinds == undefined || any(this.kinds).in(field.onKinds)) {
                    let value = this[field.name];
                    if (typeof value == "function") {
                        value = value.call(selection, field.args);
                    }
                    value = Promise.resolve(value);
                    incomingFields.push(value);
                } else {
                    throw `I do not know ${field.name}`
                }
            });

            const keys = selection.keys();

            Promise.all(incomingFields)
                .then(values => {
                    const result = {};
                    values.forEach((value, index) => {
                        result[keys[index]] = value;
                    });
                    resolve(result);
                })
                .catch(reason => reject(reason))
        });
    }
}

export interface Field {
    name: Name;
    onKinds?: Set<Name>;
    args: Map<Name, any>;
    subSelection?: Selection;
}

export class Selection extends Map<Name, Field> {
    constructor(node: SelectionSetNode,
                namedFragments: Map<string, FragmentDefinitionNode>) {
        super();
        this.onSelections(undefined, node.selections, namedFragments);
    }

    private onSelections(onType: Name | undefined,
                         selections: ReadonlyArray<SelectionNode>,
                         namedFragments: Map<string, FragmentDefinitionNode>) {
        selections.forEach(node => {
            switch (node.kind) {
                case "Field":
                    const key = (node.alias || node.name).value;
                    let field = this.get(key);

                    if (field == undefined) {
                        this.onNewField(onType, key, node, namedFragments);
                    } else { /* field != undefined */
                        this.onExistingField(onType, field, node, namedFragments);
                    }
                    break;
                case "FragmentSpread":
                    const name = node.name.value;
                    const fragment = namedFragments.get(name);
                    if (fragment == undefined) {
                        throw `Fragment ${name} is missing`
                    }
                    this.onSelections(fragment.typeCondition.name.value,
                        fragment.selectionSet.selections,
                        namedFragments);
                    break;

                case "InlineFragment":
                    this.onSelections(node.typeCondition.name.value,
                        node.selectionSet.selections,
                        namedFragments);
            }
        });
    }

    private onNewField(onType: string | undefined,
                       key: string,
                       node: FieldNode,
                       namedFragments: Map<string, FragmentDefinitionNode>) {
        const args = new Map<string, any>();
        node.arguments.forEach((arg: ArgumentNode) => {
            args.set(arg.name.value, arg.value);
        });

        const field: Field = {
            name: node.name.value,
            args: args,
        };
        if (onType != undefined) {
            field.onKinds = new Set([onType]);
        }
        if (node.selectionSet) {
            field.subSelection = new Selection(node.selectionSet, namedFragments);
        }
        this.set(key, field);
    }

    private onExistingField(onType: string | undefined,
                            field: Field,
                            node: FieldNode,
                            namedFragments: Map<string, FragmentDefinitionNode>) {
        field.onKinds.add(onType);
        field.subSelection.onSelections(onType, node.selectionSet.selections, namedFragments);
    }
}

export class Root {
    query?: ObjectNode;
    mutation?: ObjectNode;
    subscription?: ObjectNode;

    execute(node: DocumentNode, operationName?: string, variables?: Map<string, any>) {
        // Extract operations and fragments by name
        const operations = new Map<string, OperationDefinitionNode>();
        const namedFragments = new Map<string, FragmentDefinitionNode>();

        node.definitions.forEach(value => {
            if (value.kind == "OperationDefinition") {
                const name = value.name.value || '';
                operations.set(name, value);
            } else if (value.kind == "FragmentDefinition") {
                const name = value.name.value || '';
                namedFragments.set(name, value);
            }
        });

        // Find the request's operation
        let operation: OperationDefinitionNode;
        if (operationName == undefined) {
            const seq = operations.values();
            const first = seq.next();
            operation = first.value;
            if (!seq.next().done) {
                throw `An operation name is required to distinguish between ${operations.size} operations`
            }
            if (operation == undefined) {
                throw `Please provide an operation`
            }
        } else {
            operation = operations.get(operationName);
            if (operation == undefined) {
                throw `The specified operation (${operationName}) is not available in the query document`
            }
        }

        const operationType = operation.operation;

        const root = {
            "query": this.query,
            "subscription": this.subscription,
            "mutation": this.mutation,
        }[operationType];

        if (root == undefined) {
            throw `The schema does not support ${operationType} operations`
        }

        const rootSelection = new Selection(operation.selectionSet, namedFragments);

        return root.evaluate(rootSelection);
    }
}

class OurRoot extends Root {
    world = "world";
    query = Object.assign(new ObjectNode("Query"), {
        hello: {world: this.world}
    });
    mutation = Object.assign(new ObjectNode("Mutation"), {
        become: (args) => {
            const world = args.get("world").value;
            if (world != undefined) {
                this.world = world;
            }
            return {world: this.world}
        }
    });
}


new OurRoot().execute(parse(`
query Foo { hello { world }}
mutation Bar { become(world: "Apollo") { world }}`), 'Bar')
    .then(value => console.log("=>", JSON.stringify(value, null, 2)))
    .catch(reason => console.log("!!", reason));
