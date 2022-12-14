/* eslint-disable no-unused-vars */
/* eslint-disable lines-between-class-members */
/* eslint-disable no-dupe-class-members */
/**
 * Generates a SHACLC file stream from a quad stream, since SHACLC is
 * lossy with respect to N3, a stream of quads that could not be
 * written is also output.
 */
import {
  Term, Quad, Quad_Object, NamedNode,
} from 'n3';
import type * as RDF from '@rdfjs/types';
import { termToString } from 'rdf-string-ttl';
import {
  sh, rdf, rdfs, owl,
} from './ontologies';
import Store from './volatile-store';
import Writer from './writer';
import { getShaclName } from './utils';
import propertyParam from './property-param ';
import basePrefixes from './base-prefixes';
import nodeParam from './node-param';

type Property = { name: string, type: 'pred' | 'not', object: Quad_Object }

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
  ) {
    for (const key of Object.keys(prefixes)) {
      const iri = prefixes[key];
      if (typeof iri === 'string') {
        this.prefixRev[iri] = key;
        this.prefixes[key] = iri;
      } else {
        this.prefixes[key] = iri.value;
        this.prefixRev[iri.value] = key;
      }
    }
    this.writer = writer;
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
      if (!base.equals(new NamedNode('urn:x-base:default'))) this.writer.add(`BASE ${termToString(base)}`).newLine();

      await this.writeImports(base);
    } else {
      throw new Error('Base expected');
    }

    await this.writePrefixes();
    await this.writeShapes();

    if (this.errorOnExtraQuads && this.store.size > 0) {
      throw new Error('Dataset contains quads that cannot be written in SHACLC');
    }

    this.writer.end();
    // this.failedQuads.append(this.store.getQuads(null, null, null, null))
  }

  private async writeImports(base: NamedNode) {
    const imports = this.store.getObjectsOnce(base, new NamedNode(owl.imports), null);
    if (imports.length > 0) {
      for (const imp of imports) {
        this.writer.add(`IMPORTS <${imp.value}>`);
        this.writer.newLine(1);
      }
      this.writer.newLine(1);
    }
  }

  private async writePrefixes() {
    const keys = Object.keys(this.prefixes).filter((key) => !(key in basePrefixes)).sort();

    if (keys.length > 0) {
      for (const key of keys) {
        this.writer.add(`PREFIX ${key}: <${this.prefixes[key]}>`, true);
      }
      this.writer.newLine(1);
    }
  }

  private termToString(term: Term, disableShaclName = false) {
    // TODO: Make sure this does not introduce any errors
    try {
      if (disableShaclName) {
        throw new Error('Shacl name disabled');
      }

      return getShaclName(term);
      // eslint-disable-next-line no-empty
    } catch (e) { }
    if (term.termType === 'NamedNode') {
      const namespace = /^[^]*[#/]/.exec(term.value)?.[0];
      if (namespace && namespace in this.prefixRev) {
        return `${this.prefixRev[namespace]}:${term.value.slice(namespace.length)}`;
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
    }
    throw new Error(`Invalid term type for extra statement ${term.value} (${term.termType})`);
  }

  private async writeShapes() {
    // TODO: Determine sorting
    /**
     * Get every nodeshape declared at the top level
     */
    for (const subject of this.store.getSubjectsOnce(new NamedNode(rdf.type), new NamedNode(sh.NodeShape), null)) {
      if (this.store.getQuadsOnce(subject, new NamedNode(rdf.type), new NamedNode(rdfs.Class), null).length > 0) {
        this.writer.add('shapeClass ');
      } else {
        this.writer.add('shape ');
      }
      this.writer.add(this.termToString(subject));
      this.writer.add(' ');
      const targetClasses = this.store.getObjectsOnce(subject, new NamedNode(sh.targetClass), null);
      if (targetClasses.length > 0) {
        this.writer.add('-> ');
        for (const targetClass of targetClasses) {
          if (targetClass.termType === 'NamedNode') {
            this.writer.add(this.termToString(targetClass));
          } else {
            this.writer.add('!');
            this.writer.add(this.termToString(
              this.singleObject(targetClass, new NamedNode(sh.not), true),
            ));
          }
          this.writer.add(' ');
        }
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
    while (!termTemp.equals(new NamedNode(rdf.nil))) {
      list.push(this.singleObject(termTemp, new NamedNode(rdf.first), true));
      termTemp = this.singleObject(termTemp, new NamedNode(rdf.rest), true);
    }
    return list;
  }

  private writeIriLiteralOrArray(object: Quad_Object) {
    if (object.termType === 'BlankNode') {
      this.writer.add('[');
      let first = true;
      for (const term of this.getList(object)) {
        if (first) {
          first = false;
        } else {
          this.writer.add(' ');
        }
        this.writer.add(this.termToString(term));
      }
      this.writer.add(']');
    } else {
      this.writer.add(this.termToString(object));
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

  private writeAssigment({ name, type, object }: Property) {
    if (type === 'not') {
      this.writer.add('!');
      // object = this.singleObject(object, DataFactory.namedNode(sh._ + name), true)
    }
    this.writer.add(name);
    this.writer.add('=');
    this.writeIriLiteralOrArray(object);
  }

  private async writeAtom({ name, type, object }: Property) {
    if (type === 'not') { this.writer.add('!'); }
    switch (name) {
      case 'node': {
        if (object.termType === 'NamedNode') {
          this.writer.add(`@${this.termToString(object)}`);
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
        this.writer.add(this.termToString(object));
        return;
      }
      case 'datatype': {
        this.writer.add(this.termToString(object));
        return;
      }
      default:
        this.writer.add(name);
        this.writer.add('=');
        this.writeIriLiteralOrArray(object);
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
        this.writeAssigment(assignment);
      }
    }
  }

  private async writeParams(term: Term, first = true, allowedParam: Record<string, boolean>, shortcuts = false) {
    // TODO Stream this part
    const or = this.orProperties(term, allowedParam);
    const params = this.singleLayerPropertiesList(term, allowedParam);

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
  }

  private async writeShapeBody(term: Term, nested = true) {
    this.writer.add('{').indent();
    const properties = this.store.getObjectsOnce(term, new NamedNode(sh.property), null);

    const annotations = this.store.countQuads(term, null, null, null) > 0;

    if (annotations) { // This is expensive - fix
      this.writer.newLine(1);
    }

    await this.writeParams(term, true, nodeParam);

    if (annotations) {
      this.writer.add(' .');
    }

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
    this.writePath(this.singleObject(property, new NamedNode(sh.path), true) as Term);
    const min = this.singleObject(property, new NamedNode(sh.minCount));
    const max = this.singleObject(property, new NamedNode(sh.maxCount));
    const nodeKind = this.singleObject(property, new NamedNode(sh.nodeKind));
    // eslint-disable-next-line no-underscore-dangle
    const propertyClass = this.singleObject(property, new NamedNode(sh._class));
    const datatype = this.singleObject(property, new NamedNode(sh.datatype));
    const nodeShapes = this.store.getObjectsOnce(property, new NamedNode(sh.node), null);

    if (nodeKind) {
      this.writer.add(' ');
      this.writer.add(getShaclName(nodeKind));
    }

    if (propertyClass) {
      this.writer.add(' ');
      this.writer.add(this.termToString(propertyClass));
    }

    if (datatype) {
      this.writer.add(' ');
      this.writer.add(this.termToString(datatype));
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
        this.store.removeMatches(property, new NamedNode(sh.maxCount), undefined, undefined);
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
        this.writer.add(`@${this.termToString(node)}`);
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

    // TODO: Re-enable this
    // let esc = false;

    // for (const p of this.store.getQuads(property, null, null, null)) {
    //   if (p.predicate.termType == 'NamedNode') {
    //     if (!esc) {
    //       this.writer.add(' // ')
    //       esc = true;
    //     }

    //     this.writeIriLiteralOrArray(p.predicate);
    //     this.writer.add(' ');
    //     this.writeIriLiteralOrArray(p.object);
    //     this.writer.add(' ');

    //     this.store.removeQuad(p);
    //   }
    // }

    // if (esc) {
    //   this.writer.add(' //')
    // }

    if (nestedShapes.length === 0) {
      this.writer.add(' .');
    }
  }

  private writePath(term: Term, braces: boolean = false) {
    if (term.termType === 'NamedNode') {
      this.writer.add(this.termToString(term));
    } else if (term.termType === 'BlankNode') {
      const quads = this.store.getQuadsOnce(term, null, null, null);
      if (quads.length === 1) {
        const { predicate, object } = quads[0];
        switch (predicate.value) {
          case sh.inversePath:
            this.writer.add('^');
            this.writePath(object, true);
            return;
          case sh.alternativePath: {
            const alternatives = this.getList(object);
            if (alternatives.length === 0) {
              throw new Error('Invalid Alternative Path - no options');
            } else if (alternatives.length === 1) {
              this.writePath(alternatives[0]);
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
                this.writePath(alt, true);
              }
              if (braces) {
                this.writer.add(')');
              }
            }
            return;
          }
          case sh.zeroOrMorePath:
            this.writePath(object, true);
            this.writer.add('*');
            return;
          case sh.oneOrMorePath:
            this.writePath(object, true);
            this.writer.add('+');
            return;
          case sh.zeroOrOnePath:
            this.writePath(object, true);
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
          //   this.writePath(sequence[0]);
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
            this.writePath(alt, true);
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
