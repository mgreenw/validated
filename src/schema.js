/**
 * Serialization agnostic schema definition language.
 *
 * @copyright 2016-present, Andrey Popp <8mayday@gmail.com>
 * @flow
 */

import type {GenericMessage} from './message';

import invariant from 'invariant';
import {typeOf} from './utils';
import CustomError from 'custom-error-instance';
import levenshtein from 'levenshtein-edit-distance';
import {flatten, sortBy} from 'lodash';
import {Message, AlternativeMessage, message} from './message';

export type NodeSpec
  = {type: 'boolean'}
  | {type: 'string'}
  | {type: 'number'}
  | {type: 'any'}
  | {type: 'maybe', value: NodeSpec}
  | {type: 'mapping', value: NodeSpec}
  | {type: 'sequence', value: NodeSpec}
  | {type: 'object', values: {[key: string]: NodeSpec}, defaults: {[key: string]: any}}

export type ValidateResult = {context: Context; value: any};

type Refine = (value: any, error: (message: GenericMessage) => void) => any;
type ValidateKeyValue = (context: Context, key: string, keyContext: Context) => ValidateResult;
type ValidateValue = (context: Context) => ValidateResult;

export class Context {

  parent: ?Context;
  message: ?GenericMessage;

  constructor(message: ?GenericMessage = null, parent: ?Context = null) {
    this.message = message;
    this.parent = parent;
  }

  buildMapping(_validateValue: ValidateKeyValue): ValidateResult {
    throw new Error('not implemented');
  }

  buildSequence(_validateValue: ValidateValue): ValidateResult {
    throw new Error('not implemented');
  }

  unwrap(_validate: (value: any) => any): ValidateResult {
    throw new Error('not implemented');
  }

  buildMessage(originalMessage: ?GenericMessage, _contextMessages: Array<GenericMessage>) {
    return originalMessage;
  }

  error(originalMessage: ?GenericMessage): void {
    let context = this;
    let contextMessages = [];
    do {
      if (context.message) {
        contextMessages.push(context.message);
      }
      context = context.parent;
    } while (context);
    originalMessage = this.buildMessage(originalMessage, contextMessages);
    throw validationError(originalMessage, contextMessages);
  }
}

class NullContext extends Context {

  // $FlowIssue: ...
  buildMapping(_validateValue) {
    this.error('Expected a mapping value but got undefined');
  }

  // $FlowIssue: ...
  buildSequence(_validateValue) {
    this.error('Expected an array value but got undefined');
  }

  unwrap(validate) {
    let value = validate(undefined);
    return {value, context: this};
  }

  buildMessage(originalMessage, contextMessages) {
    if (this.parent) {
      return this.parent.buildMessage(originalMessage, contextMessages);
    } else {
      return originalMessage;
    }
  }
}

export let ValidationError = CustomError('ValidationError');

ValidationError.prototype.toString = function() {
  return this.message;
};

export function validationError(originalMessage: ?GenericMessage, contextMessages: Array<GenericMessage>) {
  let messages = [originalMessage].concat(contextMessages);
  let message = messages.join('\n');
  return new ValidationError({message, messages, originalMessage, contextMessages});
}

export class Node {

  validate(_context: Context): ValidateResult {
    let message = `${this.constructor.name}.validate(context) is not implemented`;
    throw new Error(message);
  }

  andThen(refine: Refine): Node {
    return new RefineNode(this, refine);
  }
}

export class RefineNode extends Node {

  validator: Node;
  refine: Refine;

  constructor(validator: Node, refine: Refine) {
    super();
    this.validator = validator;
    this.refine = refine;
  }

  validate(context: Context): ValidateResult {
    let {value, ...result} = this.validator.validate(context);
    value = this.refine(value, context.error.bind(context));
    return {...result, value};
  }
}

export class AnyNode extends Node {

  validate(context: Context) {
    return context.unwrap(value => {
      if (value == null) {
        let repr = value === null ? 'null' : 'undefined';
        context.error(`Expected a value but got ${repr}`);
      }
      return value;
    });
  }
}

export let any = new AnyNode();

export class MappingNode extends Node {

  valueNode: Node;

  constructor(valueNode: Node = any) {
    super();
    this.valueNode = valueNode;
  }

  validate(context: Context) {
    return context.buildMapping(context => this.valueNode.validate(context));
  }
}

export function mapping(valueNode: Node) {
  return new MappingNode(valueNode);
}

type ObjectNodeOptions = {
  allowExtra: boolean;
};

export class ObjectNode extends Node {

  values: {[name: string]: Node};
  valuesKeys: Array<string>;
  defaults: Object;
  options: ObjectNodeOptions;

  constructor(values: {[name: string]: Node}, defaults: ?Object = {}, options: ObjectNodeOptions) {
    super();
    this.values = values;
    this.valuesKeys = Object.keys(values);
    this.defaults = defaults || {};
    this.options = options;
  }

  validate(context: Context) {
    let res = context.buildMapping((valueContext, key, keyContext) => {
      if (this.values[key] === undefined) {
        if (!this.options.allowExtra) {
          let suggestion = this._guessSuggestion(key);
          if (suggestion) {
            keyContext.error(`Unexpected key: "${key}", did you mean "${suggestion}"?`);
          } else {
            keyContext.error(`Unexpected key: "${key}"`);
          }
        } else {
          return valueContext.unwrap(value => value);
        }
      }
      let value = this.values[key].validate(valueContext);
      return value;
    });
    let value = res.value;
    for (let key in this.values) {
      if (this.values.hasOwnProperty(key)) {
        if (value[key] === undefined) {
          if (this.defaults[key] === undefined) {
            let message = `While validating missing value for key "${key}"`;
            message = context.buildMessage(message, []);
            let nullContext = new NullContext(message, context);
            let {value: missingValue} = this.values[key].validate(nullContext);
            if (missingValue !== undefined) {
              value[key] = missingValue;
            }
          } else {
            value[key] = this.defaults[key];
          }
        }
      }
    }
    return {...res, value};
  }

  _guessSuggestion(key: string): ?string {
    let suggestions = this.valuesKeys.map(suggestion => ({
      distance: levenshtein(suggestion, key),
      suggestion
    }));
    let suggestion = sortBy(suggestions, suggestion => suggestion.distance)[0];
    if (suggestion.distance === key.length) {
      return null;
    } else {
      return suggestion.suggestion;
    }
  }
}

export function object(values: {[name: string]: Node}, defaults: ?Object) {
  return new ObjectNode(values, defaults, {allowExtra: false});
}

export function partialObject(values: {[name: string]: Node}, defaults: ?Object) {
  return new ObjectNode(values, defaults, {allowExtra: true});
}

export class SequenceNode extends Node {

  valueNode: Node;

  constructor(valueNode: Node = any) {
    super();
    this.valueNode = valueNode;
  }

  validate(context: Context) {
    return context.buildSequence(context => this.valueNode.validate(context));
  }
}

export function sequence(valueNode: Node = any) {
  return new SequenceNode(valueNode);
}

export class MaybeNode extends Node {

  valueNode: Node;

  constructor(valueNode: Node) {
    super();
    this.valueNode = valueNode;
  }

  validate(context: Context) {
    return context.unwrap(value => {
      if (value == null) {
        return value;
      }
      return this.valueNode.validate(context).value;
    });
  }
}

export function maybe(valueNode: Node) {
  return new MaybeNode(valueNode);
}

export class EnumerationNode extends Node {

  values: Array<any>;

  constructor(values: Array<any>) {
    super();
    this.values = values;
  }

  validate(context: Context) {
    return context.unwrap(value => {
      for (let i = 0; i < this.values.length; i++) {
        if (value === this.values[i]) {
          return value;
        }
      }
      let expectation = this.values.map(v => JSON.stringify(v)).join(', ');
      let repr = JSON.stringify(value);
      context.error(`Expected value to be one of ${expectation} but got ${repr}`);
    });
  }
}

export function enumeration(...values: Array<any>) {
  return new EnumerationNode(values);
}

export class OneOfNode extends Node {

  nodes: Array<Node>;

  constructor(nodes: Array<Node>) {
    super();
    this.nodes = nodes;
  }

  validate(context: Context): ValidateResult {
    let errors = [];
    for (let i = 0; i < this.nodes.length; i++) {
      try {
        return this.nodes[i].validate(context);
      } catch (error) {
        if (error instanceof ValidationError) {
          errors.push(error);
          continue;
        } else {
          throw error;
        }
      }
    }
    invariant(
      errors.length > 0,
      'Impossible happened'
    );
    throw optimizeOneOfError(errors);
  }
}

export function oneOf(...nodes: Array<Node>) {
  return new OneOfNode(nodes);
}

function optimizeOneOfError(errors) {
  let sections = errors.map(error => error.messages);

  sections = sections.map(messages => {
    if (messages[0] instanceof AlternativeMessage) {
      return explode(messages[0].alternatives, messages.slice(1));
    } else {
      return [messages];
    }
  });
  sections = flatten(sections);

  let maxWeight = Math.max.apply(null, sections.map(message => weightMessage(message)));

  sections = sections.filter(message => {
    return weightMessage(message) === maxWeight;
  });

  if (sections.length === 1) {
    return validationError(sections[0][0], sections[0].slice(1));
  }

  sections = sections.map(messages => {
    messages = messages.slice(0);
    messages.reverse();
    return messages;
  });

  // Collect same lines into a separate section
  let same = [];
  let i = 0;
  while (!sections.every(lines => lines[i] === undefined)) {
    if (sections.every(lines => lines[i] === sections[0][i])) {
      same.unshift(sections[0][i]);
    }
    i++;
  }

  sections = sections
    .map(lines => {
      lines = lines.slice(same.length);
      lines.reverse();
      return message(null, lines);
    });

  // Collect alternatives
  let alternatives = [];
  sections.forEach(lines => {
    if (!alternatives.find(msg => sameMessage(msg, lines))) {
      alternatives.push(message(null, lines));
    }
  });

  return validationError(new AlternativeMessage(alternatives), same);
}

function sameMessage(a, b) {
  if (a === b) {
    return true;
  } else if (a instanceof Message) {
    return (
      (b instanceof Message) &&
      sameMessage(a.message, b.message) &&
      a.children.length === b.children.length &&
      a.children.every((child, idx) => sameMessage(child, b.children[idx]))
    );
  }
}

function weightMessage(msg) {
  if (msg instanceof Message) {
    return msg.children.length;
  } else if (Array.isArray(msg)) {
    return msg.length;
  } else {
    return 1;
  }
}

export class StringNode extends Node {

  validate(context: Context) {
    return context.unwrap(value => {
      if (typeof value !== 'string') {
        context.error(`Expected value of type string but got ${typeOf(value)}`);
      }
      return value;
    });
  }
}

export let string = new StringNode();

export class NumberNode extends Node {

  validate(context: Context) {
    return context.unwrap(value => {
      if (typeof value !== 'number') {
        context.error(`Expected value of type number but got ${typeOf(value)}`);
      }
      return value;
    });
  }
}

export let number = new NumberNode();

export class BooleanNode extends Node {

  validate(context: Context) {
    return context.unwrap(value => {
      if (typeof value !== 'boolean') {
        context.error(`Expected value of type boolean but got ${typeOf(value)}`);
      }
      return value;
    });
  }
}

export let boolean = new BooleanNode();

export class RefNode extends Node {

  node: ?Node;

  constructor() {
    super();
    this.node = null;
  }

  validate(context: Context): ValidateResult {
    invariant(
      this.node != null,
      'Trying to validate with an unitialized ref'
    );
    return this.node.validate(context);
  }

  set(node: Node): void {
    this.node = node;
  }
}

export function ref() {
  return new RefNode();
}

function explode(variations, rest) {
  let result = [];
  for (let i = 0; i < variations.length; i++) {
    result.push([variations[i]].concat(rest));
  }
  return result;
}
