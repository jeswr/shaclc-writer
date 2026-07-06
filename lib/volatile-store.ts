/* eslint-disable camelcase */
/* eslint-disable no-dupe-class-members */
/* eslint-disable lines-between-class-members */
/* eslint-disable no-unused-vars */
/**
 * Convenience class that extends the n3 store API that consumes
 * quads as they are extracted from the store
 *
 * Consumed quads are marked in a set rather than being removed from the
 * store; physically removing quads one-by-one makes serialization time
 * quadratic in the number of quads, since each removal pays an emptiness
 * check that is linear in the size of the store index it is removed from.
 * As a consequence `size` still reports the physical store size; use
 * `getQuads(null, null, null, null)` to observe the remaining quads
 */
import {
  Store, OTerm, Quad, Quad_Subject, Quad_Predicate, Quad_Object, Term, termToId,
} from 'n3';
import type * as RDF from '@rdfjs/types';

function quadKey(quad: RDF.BaseQuad): string {
  return `${termToId(quad.subject as Term)} ${termToId(quad.predicate as Term)} ${
    termToId(quad.object as Term)} ${termToId(quad.graph as Term)}`;
}

export default class VolitileStore extends Store {
  // Initialized lazily since the base class constructor adds the initial
  // quads before field initializers of this class have run
  private consumed?: Set<string>;

  getQuads(s: OTerm, p: OTerm, o: OTerm, g: OTerm): Quad[] {
    const quads = super.getQuads(s, p, o, g);
    const { consumed } = this;
    if (!consumed || consumed.size === 0) {
      return quads;
    }
    return quads.filter((quad) => !consumed.has(quadKey(quad)));
  }

  getSubjects(p: OTerm, o: OTerm, g: OTerm): Quad_Subject[] {
    return VolitileStore.unique(this.getQuads(null, p, o, g).map((quad) => quad.subject));
  }

  getPredicates(s: OTerm, o: OTerm, g: OTerm): Quad_Predicate[] {
    return VolitileStore.unique(this.getQuads(s, null, o, g).map((quad) => quad.predicate));
  }

  getObjects(s: OTerm, p: OTerm, g: OTerm): Quad_Object[] {
    return VolitileStore.unique(this.getQuads(s, p, null, g).map((quad) => quad.object));
  }

  addQuad(
    subject: RDF.Quad['subject'],
    predicate: RDF.Quad['predicate'],
    object: RDF.Quad['object'],
    graph?: RDF.Quad['graph'],
    done?: () => void,
  ): boolean;
  addQuad(quad: RDF.Quad): boolean;
  addQuad(
    subjectOrQuad: RDF.Quad | RDF.Quad['subject'],
    predicate?: RDF.Quad['predicate'],
    object?: RDF.Quad['object'],
    graph?: RDF.Quad['graph'],
    done?: () => void,
  ): boolean {
    if (predicate) {
      return super.addQuad(
        subjectOrQuad as RDF.Quad['subject'],
        predicate,
        object as RDF.Quad['object'],
        graph,
        done,
      );
    }
    const quad = subjectOrQuad as RDF.Quad;
    // Re-adding a consumed quad restores it rather than duplicating it
    if (this.consumed?.delete(quadKey(quad))) {
      return true;
    }
    return super.addQuad(quad);
  }

  addQuads(quads: RDF.Quad[]): void {
    for (const quad of quads) {
      this.addQuad(quad);
    }
  }

  removeQuads(quads: RDF.Quad[]): void {
    if (!this.consumed) {
      this.consumed = new Set();
    }
    for (const quad of quads) {
      this.consumed.add(quadKey(quad));
    }
  }

  getQuadsOnce(s: OTerm, p: OTerm, o: OTerm, g: OTerm): Quad[] {
    const quads = this.getQuads(s, p, o, g);
    this.removeQuads(quads);
    return quads;
  }

  getSubjectsOnce(p: OTerm, o: OTerm, g: OTerm): Quad_Subject[] {
    return this.getQuadsOnce(null, p, o, g).map((term) => term.subject);
  }

  getObjectsOnce(s: OTerm, p: OTerm, g: OTerm): Quad_Object[] {
    return this.getQuadsOnce(s, p, null, g).map((term) => term.object);
  }

  private static unique<T extends Term>(terms: T[]): T[] {
    const map = new Map<string, T>();
    for (const term of terms) {
      map.set(termToId(term), term);
    }
    return [...map.values()];
  }
}
