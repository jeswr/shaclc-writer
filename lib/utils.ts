/**
   * Get the frame of an IRI that we expect to be in the SHACL namespace
   */

import { Term } from 'n3';
import { sh } from './ontologies';

// eslint-disable-next-line import/prefer-default-export
export function getShaclName(term: Term) {
  if (term.termType !== 'NamedNode' || !term.value.startsWith(sh._)) {
    throw new Error(`Term ${term.value} is not part of the SHACL namespace`);
  }
  return term.value.slice(27);
}
