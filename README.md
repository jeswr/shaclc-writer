# shaclc-writer

Write RDF/JS quads to SHACLC documents

## Usage

```ts
import { Parser } from 'n3';
import { write } from 'shaclc-write';

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
`

async function main() {
  const quads = (new Parser()).parse(ttl);

  const { text } = await write(quads, {
    prefixes: {
      ex: "http://example.org/test#",
      sh: "http://www.w3.org/ns/shacl#",
      owl: "http://www.w3.org/2002/07/owl#"
    }
  });


  // BASE <http://example.org/array-in>
  // PREFIX ex: <http://example.org/test#>
  //
  // shape ex:TestShape {
  // 	ex:property in=[ex:Instance1 true "string" 42] .
  // }
  console.log(text)
}

main();
```

### Identifying quads that could not be serialized

By default an error is thrown if there are quads that cannot be serialised in SHACLC. Alternatively we can skip throwing errors and just return the quads that cannot be serialised.


```ts
import { Parser } from 'n3';
import { write } from 'shaclc-write';

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

ex:Jesse ex:knows ex:Bob .

`

async function main() {
  const quads = (new Parser()).parse(ttl);

  const { text, extraQuads } = await write(quads, {
    prefixes: {
      ex: "http://example.org/test#",
      sh: "http://www.w3.org/ns/shacl#",
      owl: "http://www.w3.org/2002/07/owl#"
    },
    errorOnUnused: false
  });


  // BASE <http://example.org/array-in>
  // PREFIX ex: <http://example.org/test#>
  //
  // shape ex:TestShape {
  // 	ex:property in=[ex:Instance1 true "string" 42] .
  // }
  console.log(text)

  // Array containing a single RDF/JS representing the triple "ex:Jesse ex:knows ex:Bob"
  console.log(extraQuads)
}

main();
```
