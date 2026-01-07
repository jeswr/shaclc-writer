/* eslint-disable no-undef */
import type * as RDF from '@rdfjs/types';
import fs, { readFileSync } from 'fs';
import {
  DataFactory, Parser, Prefixes,
} from 'n3';
import { parse } from 'shaclc-parse';
import path from 'path';
import * as N3 from 'n3';
import SHACLCWriter from '../lib/ShaclcGenerator';
import MyStore from '../lib/volatile-store';
import MyWriter from '../lib/writer';
import 'jest-rdf';

import errorSuiteImport from './error-suite/errors.json';

import { write } from '../lib/index';

const errorSuite: Record<string, string> = errorSuiteImport;

async function transformText(file: string, pth: string): Promise<string> {
  const parser = new Parser();
  const base = /@base <[^>]*(?=>)/ui.exec(file)?.[0]?.slice(7);
  const prefixes: Prefixes<RDF.NamedNode<string> | string> = await new Promise(
    (resolve, reject) => {
      parser.parse(file, (error, quads, pref: Prefixes<RDF.NamedNode<string>>) => {
        if (pref) {
          resolve(pref);
        }
        if (error) {
          reject(error);
        }
      });
    },
  );
  if (prefixes.ex && typeof prefixes.ex === 'string') {
    prefixes.ex = DataFactory.namedNode(prefixes.ex ?? 'http://example.org/test#');
  }
  const fileQuads = parser.parse(file);
  const store = new MyStore();
  store.addQuads(fileQuads);
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    try {
      let s = '';
      const w = new MyWriter({
        write: (chunk: string) => {
          s += chunk;
        },
        end: () => {
          resolve(s);
        },
      });
      const writer = new SHACLCWriter(
        store,
        w,
        prefixes,
        base ? DataFactory.namedNode(base) : undefined,
        true, // error on unused
        false, // mint prefixes
        globalThis.fetch,
        false, // extended syntax
        !pth.includes('no-base'), // require base
      );
      await writer.write();
    } catch (e) {
      reject(e);
    }
  });
}

async function getText(pth: string) {
  const file = readFileSync(pth).toString();
  return transformText(file, pth);
}

const basePath = path.join(__dirname, 'shaclc-test-suite');
describe('Running SHACLC test suite', () => {
  const paths = fs.readdirSync(basePath).map((f) => /^[^.]*/.exec(f)?.[0]);
  const hash: {[path: string]: boolean} = {};
  const uniquePaths = [];
  for (const pth of paths) {
    if (pth && !(pth in hash)) {
      uniquePaths.push(pth);
      hash[pth] = true;
    }
  }
  for (const pth of uniquePaths) {
    // eslint-disable-next-line no-loop-func
    test(pth, async () => {
      const fullPath = path.join(basePath, pth);
      let expected = readFileSync(`${fullPath}.shaclc`).toString();
      if (pth.includes('comment')) {
        // Handle comments within the file that we do not generate
        expected = expected.replace(/( )*#[a-z ."']*\n/i, '\n')
          // Handle comments at the end of the file that we do not generat
          .replace(/( )*#[a-z ."']*$/i, '')
          // Handle double blank lines from removing comments
          .replace(/\n+$/, '\n');
      }
      // Handle inconsistencies in default path [0..*]
      expected = expected.replace(/\[0\.\.\*\] /g, '');
      // Handling indentation inconsistnecy in complex1.shaclc
      expected = expected.replace('\n\tex:ssn', '\n\n\tex:ssn');
      // Adding newline character to end required
      expected += /\n$/.test(expected) ? '' : '\n';
      // Addressing inconsistencies in indentation
      expected = expected.replace(/\n( )+/g, '\n\t');
      // Replace carried returns
      expected = expected.replace(/\r/g, '');
      // Enabling shaperef test
      expected = expected.replace('<http://example.org/test#OtherShape1>', 'ex:OtherShape1');
      // node-or-3-not
      expected = expected.replace(/ = /g, '=');
      expected = expected.replace(/ \| /g, '|');
      // dont care about ordering in complex 1
      expected = expected.replace('xsd:integer|xsd:string [1..1]', '[1..1] xsd:integer|xsd:string');
      expected = expected.replace(
        'targetNode=ex:TestNode targetSubjectsOf=ex:subjectProperty targetObjectsOf=ex:objectProperty .',
        'targetNode=ex:TestNode targetObjectsOf=ex:objectProperty targetSubjectsOf=ex:subjectProperty .',
      );
      let actual = await getText(`${fullPath}.ttl`);
      // TODO: REMOVE THIS CLEANING
      expected = expected.replace(
        'PREFIX ex: <http://example.org/directives#>',
        '',
      );
      actual = actual.replace(/\n+/g, '\n');
      expected = expected.replace(/\n+/g, '\n');
      expected = expected.replace(/^\n$/g, '');
      expected = expected.replace(/^$/g, '\n');

      expect(actual).toEqual(expected);
    });
  }
});

describe('error tests', () => {
  // eslint-disable-next-line guard-for-in
  for (const file in errorSuite) {
    // eslint-disable-next-line no-loop-func
    it(`Should throw error '${errorSuite[file]}' in file ${file}.ttl`, async () => {
      await expect(getText(path.join(__dirname, 'error-suite', `${file}.ttl`)))
        // TODO: Re-enable tests for error contexts with input
        //  errorSuite[file]
        .rejects.toThrowError();
    });
  }
});

const ttl = `
@base <http://example.org/array-in> .
@prefix ex: <http://example.org/test#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<>
  a owl:Ontology ;
.

ex:TestShape
  a sh:NodeShape ;
  sh:property [
    sh:path ex:property ;
    sh:in ( ex:Instance1 true "string" 42 ) ;
  ] ;
.
`;

jest.mock('cross-fetch', () => ({
  fetch(uri: string | URL) {
    if (`${uri}` === 'https://prefix.cc/reverse?uri=http%3A%2F%2Fexample.org%2Ftest%23&format=jsonld') {
      return {
        json() {
          return {
            test: 'http://example.org/test#',
          };
        },
      };
    }
    throw new Error(`Unexpected uri: [${uri}]`);
  },
}));

describe('index tests', () => {
  it('should do basic writing when prefixes are provided and use those prefixes', async () => {
    const quads = (new Parser()).parse(ttl);

    const { text } = await write(quads, {
      prefixes: {
        ex: 'http://example.org/test#',
        sh: 'http://www.w3.org/ns/shacl#',
        owl: 'http://www.w3.org/2002/07/owl#',
      },
    });

    expect(typeof text).toEqual('string');
    expect(text).toContain('ex:TestShape');
    expect(text).toContain('PREFIX ex: <http://example.org/test#>');
  });

  it('should do basic writing when minting of prefixes is enabled', async () => {
    const quads = (new Parser()).parse(ttl);

    const { text } = await write(quads, {
      mintPrefixes: true,
    });

    expect(typeof text).toEqual('string');
    expect(text).toContain('test:TestShape');
    expect(text).toContain('PREFIX test: <http://example.org/test#>');
  });

  it('should do basic writing when no options are provided and write uris verbosely', async () => {
    const quads = (new Parser()).parse(ttl);

    const { text } = await write(quads);

    expect(typeof text).toEqual('string');
    expect(text).toContain('<http://example.org/test#Instance1>');
  });

  it('should error on extra quads', async () => {
    const quads = (new Parser()).parse(`${ttl}\nex:Jesse ex:knows ex:Bob .`);

    const promise = write(quads, {
      prefixes: {
        ex: 'http://example.org/test#',
        sh: 'http://www.w3.org/ns/shacl#',
        owl: 'http://www.w3.org/2002/07/owl#',
      },
    });

    expect(promise).rejects.toThrowError();
  });

  it('should error on all quads in non-default graph', async () => {
    let quads = (new Parser()).parse(ttl);

    quads = quads.map((q) => DataFactory.quad(
      q.subject,
      q.predicate,
      q.object,
      DataFactory.namedNode('http://example.or/#myGraph'),
    ));

    const promise = write(quads, {
      prefixes: {
        ex: 'http://example.org/test#',
        sh: 'http://www.w3.org/ns/shacl#',
        owl: 'http://www.w3.org/2002/07/owl#',
      },
    });

    expect(promise).rejects.toThrowError();
  });

  it('should error on one quad in non-default graph', async () => {
    let quads = (new Parser()).parse(ttl);

    quads = [
      DataFactory.quad(
        quads[0].subject,
        quads[0].predicate,
        quads[0].object,
        DataFactory.namedNode('http://example.or/#myGraph'),
      ),
      ...quads.splice(1),
    ];

    const promise = write(quads, {
      prefixes: {
        ex: 'http://example.org/test#',
        sh: 'http://www.w3.org/ns/shacl#',
        owl: 'http://www.w3.org/2002/07/owl#',
      },
    });

    expect(promise).rejects.toThrowError();
  });

  it('should error on all quads in different graphs', async () => {
    let quads = (new Parser()).parse(ttl);

    let i = 0;

    quads = quads.map((q) => DataFactory.quad(
      q.subject,
      q.predicate,
      q.object,
      // eslint-disable-next-line no-plusplus
      DataFactory.namedNode(`http://example.or/#${i++}`),
    ));

    const promise = write(quads, {
      prefixes: {
        ex: 'http://example.org/test#',
        sh: 'http://www.w3.org/ns/shacl#',
        owl: 'http://www.w3.org/2002/07/owl#',
      },
    });

    expect(promise).rejects.toThrowError();
  });

  it('should produce on extra quads', async () => {
    const quads = (new Parser()).parse(`${ttl}\nex:Jesse ex:knows ex:Bob .`);

    const { text, extraQuads } = await write(quads, {
      prefixes: {
        ex: 'http://example.org/test#',
        sh: 'http://www.w3.org/ns/shacl#',
        owl: 'http://www.w3.org/2002/07/owl#',
      },
      errorOnUnused: false,
    });

    expect(typeof text).toEqual('string');
    expect(extraQuads).toEqual([
      DataFactory.quad(
        DataFactory.namedNode('http://example.org/test#Jesse'),
        DataFactory.namedNode('http://example.org/test#knows'),
        DataFactory.namedNode('http://example.org/test#Bob'),
      ),
    ]);
  });
});

describe('Testing each conformance file roundtrips', () => {
  it.each(
    fs.readdirSync(path.join(__dirname, 'shaclc-test-suite')).filter((str) => str.endsWith('.ttl')),
  )('testing %s correctly parses', async (file) => {
    const ttlString = fs.readFileSync(path.join(__dirname, 'shaclc-test-suite', file)).toString();
    const triples = (new N3.Parser()).parse(ttlString);

    const { text } = await write(triples);

    expect(text).not.toContain('  ');

    expect(
      parse(text),
    ).toBeRdfIsomorphic(
      (new N3.Parser()).parse(ttlString),
    );
  });
});

describe('Testing each extended conformance file roundtrips', () => {
  it.each(
    fs.readdirSync(path.join(__dirname, 'extended-all')).filter((str) => str.endsWith('.ttl')),
  )('testing %s correctly parses', async (file) => {
    const ttlString = fs.readFileSync(path.join(__dirname, 'extended-all', file)).toString();
    const triples = (new N3.Parser()).parse(ttlString);

    const { text } = await write(triples, {
      extendedSyntax: true, errorOnUnused: false, mintPrefixes: true, requireBase: !file.includes('no-base'),
    });

    expect(text).not.toContain('  ');

    const result = (new N3.Parser()).parse(ttlString);

    if (file.includes('no-base')) {
      result.push(DataFactory.quad(
        DataFactory.namedNode('urn:x-base:default'),
        DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        DataFactory.namedNode('http://www.w3.org/2002/07/owl#Ontology'),
      ));
    }

    expect(
      parse(text, { extendedSyntax: true }),
    ).toBeRdfIsomorphic(
      result,
    );

    expect(
      () => write(triples, { extendedSyntax: false, errorOnUnused: true, mintPrefixes: true }),
    ).rejects.toThrowError();

    expect(
      () => write(triples, { errorOnUnused: true, mintPrefixes: true }),
    ).rejects.toThrowError();
  });
});
