import { Quad, NamedNode } from '@rdfjs/types';
import { DataFactory } from 'n3';
import ShaclcGenerator from './ShaclcGenerator';
import Writer from './writer';
import VolitileStore from './volatile-store';

export interface Options {
  prefixes?: { [prefix: string]: string | NamedNode; };
  errorOnUnused?: boolean;
}

export interface Result {
  text: string;
  extraQuads?: Quad[];
}

export async function write(quads: Quad[], options?: Options): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    try {
      let s = '';
      const volatileStore = new VolitileStore(quads);

      const graphs = volatileStore.getGraphs(null, null, null);

      if (graphs.length > 1) {
        throw new Error('More than one graph found - can serialize in the default graph');
      }

      if (graphs.length === 1 && !graphs[0].equals(DataFactory.defaultGraph())) {
        throw new Error(`Expected all triples to be in the default graph, instead triples were in ${graphs[0].value}`);
      }

      const w = new Writer({
        write: (chunk: string) => {
          s += chunk;
        },
        end: () => {
          let extraQuads: Quad[] | undefined = volatileStore.getQuads(null, null, null, null);

          if (extraQuads.length === 0) {
            extraQuads = undefined;
          }

          resolve({
            text: s,
            extraQuads,
          });
        },
      });
      const writer = new ShaclcGenerator(
        volatileStore,
        w,
        options?.prefixes,
        undefined,
        options?.errorOnUnused !== false,
      );
      writer.write();
    } catch (e) {
      reject(e);
    }
  });
}
