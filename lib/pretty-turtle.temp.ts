// This is a temporary file until https://github.com/rdfjs/N3.js/issues/95#issuecomment-1321952472 is released

const fs = require('fs');
const N3 = require('n3');
const path = require('path');

const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function prettyTurtle() {
  let result = '';
  // TODO: Sort by length of prefix so best prefix gets picked
  const prefix = {
    'http://example.org/test#': 'ext', 'http://example.org/': 'ex', 'http://www.w3.org/ns/shacl#': 'ns', 'http://www.w3.org/2002/07/owl#': 'owl',
  };

  const ttl = fs.readFileSync(path.join(__dirname, 'test', 'valid', 'nestedShape.ttl')).toString();

  const store = new N3.Store((new N3.Parser()).parse(ttl));
  const writer = new N3.Writer();

  const blankObjectsToEncode = [];

  function fromPredicate(subject, indent = 1) {
    // console.('\t'.repeat(indent))
    const types = store.getObjects(subject, N3.DataFactory.namedNode(TYPE));

    // let postFix = ''
    if (types.length > 0) {
      result += ` a ${types.map((type) => encodeObject(type)).join(', ')} ;`;
    }

    const predicates = store.getPredicates(subject).filter((predicate) => !predicate.equals(N3.DataFactory.namedNode(TYPE)));

    for (const predicate of predicates) {
      const blankObjects = [];
      const nonBlankObjects = [];
      for (const object of store.getObjects(subject, predicate)) {
        if (object.termType === 'BlankNode') {
          if ([...store.match(null, null, object), ...store.match(null, object, null)].length > 1) {
            nonBlankObjects.push(object);
            blankObjectsToEncode.push(object);
          } else {
            blankObjects.push(object);
          }
        } else {
          nonBlankObjects.push(object);
        }
      }

      console.log(nonBlankObjects);
      result += `\n${'  '.repeat(indent)}${encodePredicate(predicate)} ${nonBlankObjects.map((x) => encodeObject(x)).join(', ')}`;

      if (blankObjects.length > 0) {
        if (nonBlankObjects.length > 0) {
          result += ', ';
        }

        result += '[';

        for (const blank of blankObjects) {
          fromPredicate(blank, indent + 1);
        }

        result += `\n${'  '.repeat(indent)}]`;
      }

      result += ' ;';
    }
  }

  for (const subject of store.getSubjects()) {
    if (subject.termType === 'NamedNode') {
      result += encodeSubject(subject);

      fromPredicate(subject);

      result += '\n.\n\n';
    }

    // return result;
  }

  while (blankObjectsToEncode.length > 0) {
    const subject = blankObjectsToEncode.pop();

    result += encodeSubject(subject);
    fromPredicate(subject);
    result += '\n.\n\n';
  }

  return result;
  console.log(store.getSubjects());
}

console.log(
  prettyTurtle(),
);
