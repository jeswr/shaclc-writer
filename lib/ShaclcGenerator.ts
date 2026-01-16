/* eslint-disable no-unused-vars */
/* eslint-disable lines-between-class-members */
/* eslint-disable no-dupe-class-members */
/**
 * Generates a SHACLC file stream from a quad stream, since SHACLC is
 * lossy with respect to N3, a stream of quads that could not be
 * written is also output.
 */
import {
  Term, Quad, Quad_Object, NamedNode, DataFactory as DF, Writer as N3Writer,
} from 'n3';
import { uriToPrefix } from '@jeswr/prefixcc';
import type * as RDF from '@rdfjs/types';
import { termToString } from 'rdf-string-ttl';
import {
  sh, rdf, rdfs, owl,
} from './ontologies';
import Store from './volatile-store';
import Writer from './writer';
import { getShaclName } from './utils';
import propertyParam from './property-param';
import basePrefixes from './base-prefixes';
import nodeParam from './node-param';

type Property = { name: string, type: 'pred' | 'not', object: Quad_Object }

function getNamespace(str: string) {
  return /^[^]*[#/]/.exec(str)?.[0];
}

const knownNamespaces: Record<string, string> = {
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
  'http://www.w3.org/2000/01/rdf-schema#': 'rdfs',
  'http://www.w3.org/ns/shacl#': 'sh',
  'http://www.w3.org/2001/XMLSchema#': 'xsd',
};

const knownPrefixes: Record<string, string> = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  sh: 'http://www.w3.org/ns/shacl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
};

export default class SHACLCWriter {
  private prefixes: { [prefix: string]: string } = {};

  private prefixRev: { [namespace: string]: string } = {};

  private writer: Writer;

  constructor(
    // eslint-disable-next-line no-unused-vars
    private store: Store,
    // eslint-disable-next-line no-unused-vars
    writer: Writer,
    prefixes: { [prefix: string]: string | RDF.NamedNode } = {},
    // eslint-disable-next-line no-unused-vars
    private base: NamedNode | undefined = undefined,
    private errorOnExtraQuads = true,
    private mintUnspecifiedPrefixes = false,
    private fetch?: typeof globalThis.fetch,
    private extendedSyntax = false,
    private readonly requireBase = true,
  ) {
    for (const key of Object.keys(prefixes)) {
      const iri = prefixes[key];
      const value = typeof iri === 'string' ? iri : iri.value;

      if (!(value in knownNamespaces) && !(key in knownPrefixes)) {
        this.prefixRev[value] = key;
        this.prefixes[key] = value;
      }
    }
    this.writer = writer;
    this.requireBase = requireBase;
  }

  /**
   * Used to initiate the flow of data through the writer.
   */
  // TODO: Make initialisation async
  public async write() {
    const onotology = this.store.getQuads(null, rdf.type, owl.Ontology, null);

    if (onotology.length === 1 && onotology[0].subject.termType === 'NamedNode') {
      const base = onotology[0].subject;
      this.store.removeQuads(onotology);

      // Don't write default
      if (!base.equals(DF.namedNode('urn:x-base:default'))) this.writer.add(`BASE ${termToString(base)}`);

      await this.writeImports(base);
    } else if (this.requireBase) {
      throw new Error('Base expected');
    }

    if (this.mintUnspecifiedPrefixes) {
      const namespaces = new Set<string>();

      for (const term of [
        ...this.store.getSubjects(null, null, null),
        ...this.store.getPredicates(null, null, null),
        ...this.store.getObjects(null, null, null),
      ]) {
        if (term.termType === 'NamedNode') {
          const namespace = getNamespace(term.value);
          if (namespace && !(namespace in this.prefixRev) && !(namespace in knownNamespaces)) {
            namespaces.add(namespace);
          }
        }
      }

      const existingPrefixes = { ...this.prefixes, ...knownPrefixes };

      await Promise.all(
        [...namespaces].map((ns) => uriToPrefix(ns, {
          fetch: this.fetch,
          mintOnUnknown: true,
          existingPrefixes,
        }).then((pref) => {
          this.prefixes[pref] = ns;
          existingPrefixes[pref] = ns;
          this.prefixRev[ns] = pref;
        })),
      );
    }

    const allNamespaces = new Set<string>([
      ...this.store.getSubjects(null, null, null),
      ...this.store.getPredicates(null, null, null),
      ...this.store.getObjects(null, null, null),
    ]
      .filter((term) => term.termType === 'NamedNode')
      .map((term) => getNamespace(term.value))
      .filter((str): str is string => typeof str === 'string'));

    for (const key in this.prefixRev) {
      if (!allNamespaces.has(key)) {
        delete this.prefixes[this.prefixRev[key]];
        delete this.prefixRev[key];
      }
    }

    await this.writePrefixes();

    this.prefixes = { ...this.prefixes, ...knownPrefixes };
    this.prefixRev = { ...this.prefixRev, ...knownNamespaces };

    this.writer.newLine();

    await this.writeShapes();

    if (this.extendedSyntax) {
      const subjects = this.store.getSubjects(null, null, null);

      if (subjects.length > 0) {
        this.writer.newLine(1);
      }

      for (const subject of subjects) {
        this.writer.add(await this.termToString(subject, true, true));
        this.writer.add(' ');
        this.writer.indent();
        await this.writeTurtlePredicates(subject);
        this.writer.deindent();
      }
      if (subjects.length > 0) {
        this.writer.add(' .');
        this.writer.newLine();
      }
    }

    if (this.errorOnExtraQuads && this.store.size > 0) {
      throw new Error(`Dataset contains quads that cannot be written in SHACLC [\n${
        new N3Writer({ prefixes: this.prefixes }).quadsToString(this.store.getQuads(null, null, null, null))
      }]`);
    }

    this.writer.end();
    // this.failedQuads.append(this.store.getQuads(null, null, null, null))
  }

  private async writeImports(base: NamedNode) {
    const imports = this.store.getObjectsOnce(base, DF.namedNode(owl.imports), null);
    if (imports.length > 0) {
      for (const imp of imports) {
        this.writer.add(`IMPORTS <${imp.value}>`, true);
      }
    }
  }

  private async writePrefixes() {
    const keys = Object.keys(this.prefixes).filter((key) => !(key in basePrefixes)).sort();

    if (keys.length > 0) {
      for (const key of keys) {
        this.writer.add(`PREFIX ${key}: <${this.prefixes[key]}>`, true);
      }
    }
  }

  private async termToString(term: Term, disableShaclName = false, allowBlankNodes = false) {
    // TODO: Make sure this does not introduce any errors
    try {
      if (disableShaclName) {
        throw new Error('Shacl name disabled');
      }

      return getShaclName(term);
      // eslint-disable-next-line no-empty
    } catch (e) { }
    if (term.termType === 'NamedNode') {
      const namespace = getNamespace(term.value);
      if (namespace && namespace in this.prefixRev) {
        if (namespace in this.prefixRev) {
          return `${this.prefixRev[namespace]}:${term.value.slice(namespace.length)}`;
        }
      }
      return termToString(term);
    } if (term.termType === 'Literal') {
      if (
        term.datatypeString === 'http://www.w3.org/2001/XMLSchema#integer'
        || term.datatypeString === 'http://www.w3.org/2001/XMLSchema#boolean'
      ) {
        return term.value;
      }
      return termToString(term);
    } if (term.termType === 'BlankNode' && allowBlankNodes) {
      termToString(term);
    }
    throw new Error(`Invalid term type for extra statement ${term.value} (${term.termType})`);
  }

  private async writeShapes() {
    // TODO: Determine sorting
    /**
     * Get every nodeshape declared at the top level
     */
    for (const subject of this.store.getSubjectsOnce(DF.namedNode(rdf.type), DF.namedNode(sh.NodeShape), null)) {
      if (this.store.getQuadsOnce(subject, DF.namedNode(rdf.type), DF.namedNode(rdfs.Class), null).length > 0) {
        this.writer.add('shapeClass ');
      } else {
        this.writer.add('shape ');
      }
      this.writer.add(await this.termToString(subject));
      this.writer.add(' ');
      const targetClasses = this.store.getObjectsOnce(subject, DF.namedNode(sh.targetClass), null);
      if (targetClasses.length > 0) {
        this.writer.add('-> ');
        for (const targetClass of targetClasses) {
          if (targetClass.termType === 'NamedNode') {
            this.writer.add(await this.termToString(targetClass));
          } else {
            this.writer.add('!');
            this.writer.add(await this.termToString(
              this.singleObject(targetClass, DF.namedNode(sh.not), true),
            ));
          }
          this.writer.add(' ');
        }
      }

      const unusedPredicates = this.store.getPredicates(subject, null, null)
        .filter((property) => [
          DF.namedNode(sh.targetClass),
          DF.namedNode(sh.property),
          // TODO: See if "and" should be here as well
          DF.namedNode(sh.or),
          ...Object.keys(nodeParam).map((key) => DF.namedNode(sh._ + key)),
        ].every((elem) => !property.equals(elem)));

      if (unusedPredicates.length > 0) {
        this.writer.add(';');
        this.writer.indent();
        this.writer.newLine(1);
      }

      if (this.extendedSyntax) {
        await this.writeGivenTurtlePredicates(subject, unusedPredicates);
      }

      if (unusedPredicates.length > 0) {
        this.writer.add(' ');
        this.writer.deindent();
      }

      await this.writeShapeBody(subject, false);
    }
  }

  private getSingleProperty(quad: Quad, allowedPredicates: Record<string, boolean>):
    Property | undefined {
    // let tempQuad = quad;
    let examining = [quad];
    try {
      let name = getShaclName(quad.predicate);
      let type: 'pred' | 'not' = 'pred';
      if (name === 'not') {
        const quads = this.store.getQuadsOnce(quad.object, null, null, null);
        // TODO: See if this line is necessary
        examining = examining.concat(quads);
        if (quads.length !== 1) {
          throw new Error('Can only handle having one predicate of \'not\'');
        }
        // eslint-disable-next-line no-param-reassign
        [quad] = quads;
        name = getShaclName(quad.predicate);
        type = 'not';
      }
      if (!(name in allowedPredicates)) {
        throw new Error(`${name} is not allowed`);
      }
      return { name, type, object: quad.object };
    } catch (e) {
      this.store.addQuads(examining);
    }
    return undefined;
  }

  private singleLayerPropertiesList(term: Term, allowedPredicates: Record<string, boolean>):
    Property[] {
    const result = [];
    for (const quad of this.store.getQuadsOnce(term, null, null, null)) {
      const property = this.getSingleProperty(quad, allowedPredicates);
      if (property) {
        result.push(property);
      }
    }
    return result;
  }

  private expectOneProperty(term: Term, allowedPredicates: Record<string, boolean>):
    Property | undefined {
    const quads = this.store.getQuadsOnce(term, null, null, null);
    if (quads.length === 1) {
      const data = this.getSingleProperty(quads[0], allowedPredicates);
      if (data) { return data; }
    }
    this.store.addQuads(quads);
    return undefined;
  }

  private orProperties(term: Term, allowedPredicates: Record<string, boolean>) {
    const orProperties: Property[][] = [];
    for (const quad of this.store.getQuadsOnce(term, new NamedNode(sh.or), null, null)) {
      const statement: Property[] = [];
      for (const item of this.getList(quad.object)) {
        const property = this.expectOneProperty(item, allowedPredicates);
        if (!property) {
          // TODO HANDLE THIS CASE BY EXTENDING SHACLC SYNTAX
          this.store.addQuad(quad);
          throw new Error('Each entry of the \'or\' statement must declare exactly one property');
        }
        statement.push(property);
      }
      orProperties.push(statement);
    }
    return orProperties;
  }

  /**
   * Extract an rdf:list
   */
  private getList(term: Term): Term[] {
    // TODO: Fix gross type casting
    let termTemp: Term = term;
    const list: Term[] = [];
    // TODO: Handle poorly formed RDF lists
    while (!termTemp.equals(DF.namedNode(rdf.nil))) {
      list.push(this.singleObject(termTemp, DF.namedNode(rdf.first), true));
      termTemp = this.singleObject(termTemp, DF.namedNode(rdf.rest), true);
    }
    return list;
  }

  private async writeIriLiteralOrArray(object: Quad_Object) {
    if (object.termType === 'BlankNode') {
      this.writer.add('[');
      let first = true;
      for (const term of this.getList(object)) {
        if (first) {
          first = false;
        } else {
          this.writer.add(' ');
        }
        this.writer.add(await this.termToString(term));
      }
      this.writer.add(']');
    } else {
      this.writer.add(await this.termToString(object));
    }
  }

  /**
   * For properties such as minCount where at most one object is expected
   *
   * @param subject
   * @param predicate
   */
  // TODO: FIX private singleObject(subject: Term, predicate: Term, strict: true): Term;
  // TODO: Put deletions in here?
  private singleObject(subject: Term | null, predicate: Term | null, strict: true): Quad_Object;
  private singleObject(subject: Term | null, predicate: Term | null): Quad_Object | undefined;
  private singleObject(subject: Term | null, predicate: Term | null, strict?: boolean):
  Quad_Object | undefined {
    return this.singleQuad(subject, predicate, strict)?.object;
  }

  private singleQuad(subject: Term | null, predicate: Term | null, strict: boolean = false):
    Quad | undefined {
    const objects = this.store.getQuadsOnce(subject, predicate, null, null);
    if (strict && objects.length !== 1) {
      this.store.addQuads(objects);
      throw new Error(`The subject and predicate ${
        subject?.value
      } ${
        predicate?.value
      } must have exactly one object. Instead has ${objects.length}`);
    }
    if (objects.length > 1) {
      this.store.addQuads(objects);
      throw new Error(`The subject and predicate ${
        subject?.value
      } ${
        predicate?.value
      } can have at most one object. Instead has ${objects.length}`);
    }
    return objects.length === 1 ? objects[0] : undefined;
  }

  private async writeAssigment({ name, type, object }: Property) {
    if (type === 'not') {
      this.writer.add('!');
      // object = this.singleObject(object, DataFactory.namedNode(sh._ + name), true)
    }
    this.writer.add(name);
    this.writer.add('=');
    await this.writeIriLiteralOrArray(object);
  }

  private async writeAtom({ name, type, object }: Property) {
    if (type === 'not') { this.writer.add('!'); }
    switch (name) {
      case 'node': {
        if (object.termType === 'NamedNode') {
          this.writer.add(`@${await this.termToString(object)}`);
        } else if (object.termType === 'BlankNode') {
          await this.writeShapeBody(object);
        } else {
          throw new Error('Invalid nested shape, must be blank node or IRI');
        }
        return;
      }
      case 'nodeKind': {
        this.writer.add(getShaclName(object));
        return;
      }
      case 'class': {
        this.writer.add(await this.termToString(object));
        return;
      }
      case 'datatype': {
        this.writer.add(await this.termToString(object));
        return;
      }
      default:
        this.writer.add(name);
        this.writer.add('=');
        await this.writeIriLiteralOrArray(object);
    }
  }

  private async writeAssigments(assignments: Property[], divider = ' ', first = true, shortcuts: boolean) {
    for (const assignment of assignments) {
      if (first) {
        // eslint-disable-next-line no-param-reassign
        first = false;
      } else {
        this.writer.add(divider);
      }
      if (shortcuts) {
        await this.writeAtom(assignment);
      } else {
        await this.writeAssigment(assignment);
      }
    }
  }

  private async writeParams(
    term: Term,
    first = true,
    allowedParam: Record<string, boolean>,
    shortcuts = false,
    surroundings = false,
  ) {
    // TODO Stream this part
    const or = this.orProperties(term, allowedParam);
    const params = this.singleLayerPropertiesList(term, allowedParam);

    if (surroundings && (or.length > 0 || params.length > 0)) {
      this.writer.newLine(1);
    }

    for (const statement of or) {
      if (first) {
        // eslint-disable-next-line no-param-reassign
        first = false;
      } else {
        this.writer.add(' ');
      }
      await this.writeAssigments(statement, '|', true, shortcuts);
    }

    await this.writeAssigments(params, ' ', first, shortcuts);

    if (surroundings && (or.length > 0 || params.length > 0)) {
      this.writer.add(' .');
    }
  }

  private async writeShapeBody(term: Term, nested = true) {
    this.writer.add('{').indent();
    const properties = this.store.getObjectsOnce(term, DF.namedNode(sh.property), null);

    await this.writeParams(term, true, nodeParam, false, true);

    for (const property of properties) {
      this.writer.newLine(1);
      await this.writeProperty(property);
    }

    this.writer.deindent().newLine(1);

    if (nested) {
      this.writer.add('} .');
    } else {
      this.writer.add('}').newLine(1);
    }
  }

  private async writeProperty(property: Term) {
    await this.writePath(this.singleObject(property, DF.namedNode(sh.path), true) as Term);
    const min = this.singleObject(property, DF.namedNode(sh.minCount));
    const max = this.singleObject(property, DF.namedNode(sh.maxCount));
    const nodeKind = this.singleObject(property, DF.namedNode(sh.nodeKind));
    // eslint-disable-next-line no-underscore-dangle
    const propertyClass = this.singleObject(property, DF.namedNode(sh._class));
    const datatype = this.singleObject(property, DF.namedNode(sh.datatype));
    const nodeShapes = this.store.getObjectsOnce(property, DF.namedNode(sh.node), null);

    if (nodeKind) {
      this.writer.add(' ');
      this.writer.add(getShaclName(nodeKind));
    }

    if (propertyClass) {
      this.writer.add(' ');
      this.writer.add(await this.termToString(propertyClass));
    }

    if (datatype) {
      this.writer.add(' ');
      this.writer.add(await this.termToString(datatype));
    }

    if (min !== undefined || max !== undefined) {
      this.writer.add(' [');
      if (min) {
        if (min.termType !== 'Literal' || min.datatypeString !== 'http://www.w3.org/2001/XMLSchema#integer') {
          throw new Error('Invalid min value, must me an integer literal');
        }
        this.writer.add(min.value);
      } else {
        this.writer.add('0');
      }
      this.writer.add('..');

      if (max) {
        if (max.termType !== 'Literal' || max.datatypeString !== 'http://www.w3.org/2001/XMLSchema#integer') {
          throw new Error('Invalid max value, must me an integer literal');
        }
        this.store.removeMatches(property, DF.namedNode(sh.maxCount), undefined, undefined);
        this.writer.add(max.value);
      } else {
        this.writer.add('*');
      }
      this.writer.add(']');
    }

    await this.writeParams(property, false, propertyParam, true);

    const nestedShapes = [];

    for (const node of nodeShapes) {
      if (node.termType === 'NamedNode') {
        this.writer.add(' ');
        this.writer.add(`@${await this.termToString(node)}`);
      } else if (node.termType === 'BlankNode') {
        nestedShapes.push(node);
      } else {
        throw new Error('Invalid nested shape, must be blank node or IRI');
      }
    }

    for (const shape of nestedShapes) {
      this.writer.add(' ');
      await this.writeShapeBody(shape);
    }

    if (this.extendedSyntax && this.store.getQuads(property, null, null, null).length > 0) {
      this.writer.add(' %');

      this.writer.indent();
      this.writer.newLine(1);
      await this.writeTurtlePredicates(property);
      this.writer.deindent();
      this.writer.newLine(1);
      this.writer.add('%');
    }

    if (nestedShapes.length === 0) {
      this.writer.add(' .');
    }
  }

  private async writeTurtlePredicates(term: Term) {
    return this.writeGivenTurtlePredicates(term, this.store.getPredicates(term, null, null));
  }

  private async writeGivenTurtlePredicates(term: Term, predicates: Term[]) {
    let semi = false;

    if (predicates.some(
      (predicate) => predicate.equals(DF.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')),
    )) {
      const types = this.store.getObjectsOnce(
        term,
        DF.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        null,
      );
      if (types.length > 0) {
        semi = true;
        this.writer.add('a ');
        await this.writeTurtleObjects(types);
      }
    }

    for (const predicate of predicates) {
      if (!predicate.equals(DF.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'))) {
        if (semi) {
          this.writer.add(' ;');
          this.writer.newLine(1);
        } else {
          semi = true;
        }

        this.writer.add(
          await this.termToString(predicate, true),
        );
        this.writer.add(' ');
        await this.writeTurtleObjects(
          this.store.getObjectsOnce(term, predicate, null),
        );
      }
    }
  }

  private async writeTurtleObjects(objects: Term[]) {
    const blankObjects: Term[] = [];
    const nonBlankObjects: Term[] = [];
    for (const object of objects) {
      if (object.termType === 'BlankNode'
      && [...this.store.match(null, null, object), ...this.store.match(null, object, null)].length === 0
      ) {
        blankObjects.push(object);
      } else {
        nonBlankObjects.push(object);
      }
    }

    this.writer.add(
      (await Promise.all(nonBlankObjects.map((object) => this.termToString(object, true, true)))).join(', '),
    );

    let comma = nonBlankObjects.length > 0;

    if (blankObjects.length > 0) {
      for (const blank of blankObjects) {
        if (comma) {
          this.writer.add(', ');
        } else {
          comma = true;
        }
        if (!(await this.writeList(blank))) {
          this.writer.add('[');
          this.writer.indent();
          this.writer.newLine(1);
          await this.writeTurtlePredicates(blank);
          this.writer.deindent();
          this.writer.newLine(1);
          this.writer.add(']');
        }
      }
    }
  }

  private async writeList(object: Term) {
    let node = object;
    const elems: Term[] = [];
    const quads: Quad[] = [];

    while (!node.equals(DF.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#nil'))) {
      const first = this.store.getQuadsOnce(
        node,
        DF.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#first'),
        null,
        null,
      );
      const rest = this.store.getQuadsOnce(
        node,
        DF.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#rest'),
        null,
        null,
      );

      quads.push(
        ...first,
        ...rest,
      );

      if (first.length !== 1 || rest.length !== 1 || this.store.getQuads(node, null, null, null).length !== 0) {
        this.store.addQuads(quads);
        return false;
      }

      elems.push(first[0].object);
      node = rest[0].object;
    }

    let space = false;

    this.writer.add('(');
    for (const elem of elems) {
      if (space) {
        this.writer.add(' ');
      } else {
        space = true;
      }
      await this.writeTurtleObjects([elem]);
    }
    this.writer.add(')');

    return true;
  }

  private async writePath(term: Term, braces: boolean = false) {
    if (term.termType === 'NamedNode') {
      this.writer.add(await this.termToString(term));
    } else if (term.termType === 'BlankNode') {
      const quads = this.store.getQuadsOnce(term, null, null, null);
      if (quads.length === 1) {
        const { predicate, object } = quads[0];
        switch (predicate.value) {
          case sh.inversePath:
            this.writer.add('^');
            await this.writePath(object, true);
            return;
          case sh.alternativePath: {
            const alternatives = this.getList(object);
            if (alternatives.length === 0) {
              throw new Error('Invalid Alternative Path - no options');
            } else if (alternatives.length === 1) {
              await this.writePath(alternatives[0]);
            } else {
              if (braces) {
                this.writer.add('(');
              }
              let first = true;
              for (const alt of alternatives) {
                if (first) {
                  first = false;
                } else {
                  this.writer.add('|');
                }
                await this.writePath(alt, true);
              }
              if (braces) {
                this.writer.add(')');
              }
            }
            return;
          }
          case sh.zeroOrMorePath:
            await this.writePath(object, true);
            this.writer.add('*');
            return;
          case sh.oneOrMorePath:
            await this.writePath(object, true);
            this.writer.add('+');
            return;
          case sh.zeroOrOnePath:
            await this.writePath(object, true);
            this.writer.add('?');
            return;
          default:
            throw new Error(`Invalid path type ${term.value}`);
        }
      } else {
        // TODO Make more efficient
        this.store.addQuads(quads);
        const sequence = this.getList(term);
        if (sequence.length === 0) {
          throw new Error('Invalid Path');

          // TODO: See if the following case is necessary
          // else if (sequence.length === 1) {
          //   await this.writePath(sequence[0]);
          // }
        } else {
          if (braces) {
            this.writer.add('(');
          }
          let first = true;
          for (const alt of sequence) {
            if (first) {
              first = false;
            } else {
              this.writer.add('/');
            }
            await this.writePath(alt, true);
          }
          if (braces) {
            this.writer.add(')');
          }
        }
      }
    } else {
      throw new Error('Path should be named node or blank node');
    }
  }
}
