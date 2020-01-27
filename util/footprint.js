const Fs = require('fs');
const Path = require('path');
const Fetch = require('node-fetch');
const N3 = require("n3");
const { DataFactory } = N3;
const { namedNode, literal, defaultGraph, quad } = DataFactory;
const C = require('./constants');
const Jsonld = require('jsonld');
const Relateurl = require('relateurl');
const UriTemplate = require('uri-template-lite').URI.Template;
const ShExCore = require('@shexjs/core')
const ShExParser = require('@shexjs/parser')

/** LocalResource - a resource that has a nominal directory but is always resolved by a filesystem path
 */
class LocalResource {
  constructor (url, path) {
    if (!(url instanceof URL)) throw Error(`url ${url} must be an instance of URL`);
    this.url = url.href;
    this.prefixes = {};
    this.graph = null;
    this.path = path
  }

  async fetch () {
    const text = await Fs.promises.readFile(this.path, 'utf8');
    this.graph = await parseTurtle(text, this.url, this.prefixes);
    return this
  }

  async serialize () {
    return await serializeTurtle(this.graph, this.url, this.prefixes)
  }

  async write () {
    const text = await this.serialize();
    await Fs.promises.writeFile(this.path, text, {encoding: 'utf8'});
    return this
  }

}

/** LocalContainer - a local LDP-C
 */
class LocalContainer extends LocalResource {
  constructor (rootUrl, urlPath, documentRoot, indexFileName, title, footprintUrl, footprintInstancePath) {
    if (!(rootUrl instanceof URL))
      throw Error(`rootUrl ${rootUrl} must be an instance of URL`);
    if (!(rootUrl.pathname.endsWith('/')))
      throw Error(`rootUrl ${rootUrl} must end with '/'`);
    if (footprintUrl && !(footprintUrl instanceof URL))
      throw Error(`footprintUrl ${footprintUrl} must be an instance of URL`);

    const filePath = Path.join(documentRoot, urlPath);
    const indexFile = Path.join(filePath, indexFileName);
    super(new URL(urlPath, rootUrl), indexFile);
    this.graph = new N3.Store();
    if (Fs.existsSync(indexFile)) {
      this.graph.addQuads(parseTurtleSync(Fs.readFileSync(indexFile, 'utf8'), this.url, {}));
      this.prefixes = { // @@ should come from parseTurtle, but that's only available in async
        ldp: C.ns_ldp,
        xsd: C.ns_xsd,
        foot: C.ns_foot,
        dc: C.ns_dc,
      }
    } else {
      this.graph.addQuads(parseTurtleSync(LocalContainer.makeContainer(title, footprintUrl, footprintInstancePath, this.prefixes), this.url, {}));
      if (!Fs.existsSync(filePath))
        Fs.mkdirSync(filePath);
      const container = serializeTurtleSync(this.graph, this.url, this.prefixes);
      Fs.writeFileSync(indexFile, container, {encoding: 'utf8'});
    }
    this.subdirs = []
  }

  addSubdirs (addUs) {
    this.subdirs.push(...addUs);
    return this
  }

  async merge (payload, base) {
    // istanbul ignore next
    const g2 = payload instanceof N3.Store ? payload : await parseTurtle(payload, base, {});
    this.graph.addQuads(g2.getQuads());
    return this
  }

  addMember (location, footprintUrl) {
    this.graph.addQuad(namedNode(this.url), namedNode(C.ns_ldp + 'contains'), namedNode(location));
    return this
  }

  async registerApp (footprint, filePath, body, base, contentType, parent) {
    const payloadGraph = contentType === 'application/ld+json'
          ? await parseJsonLd(body, base, {})
          : await parseTurtle(body, base, {});
    const stomped = payloadGraph.getQuads(null, namedNode(C.ns_ldp + 'app'), null)[0].object;
    const name = payloadGraph.getQuads(stomped, namedNode(C.ns_ldp + 'name'), null)[0].object;
    const toApps = Relateurl.relate(this.url, '/', { output: Relateurl.PATH_RELATIVE });
    const thisAppDir = Path.join(Path.parse(this.path).dir, toApps, 'Apps', name.value);
    const thisAppUrl = new URL(Path.join('/', 'Apps', name.value), this.url);
    if (!Fs.existsSync(thisAppDir))
      Fs.mkdirSync(thisAppDir);
    const appIndexFile = Path.join(thisAppDir, C.indexFile);
    const asGraph = Fs.existsSync(appIndexFile) ? await parseTurtle(Fs.readFileSync(appIndexFile, 'utf8'), thisAppUrl.href, {}) : new N3.Store()
    const prefixes = {
      foot: C.ns_foot,
      xsd: C.ns_xsd,
    }
    const appFileText = Object.entries(prefixes).map(p => `PREFIX ${p[0]}: <${p[1]}>`).join('\n') + `
<> foot:installedIn
  [ foot:app <${stomped.value}> ;
    foot:footprintRoot <${footprint.url.href}> ;
    foot:footprintInstancePath "${filePath}" ;
    foot:instantiationDateTime "${new Date().toISOString()}"^^xsd:dateTime ;
  ] .
<${stomped.value}> foot:name "${name.value}" .
`
    const toAdd = await parseTurtle(appFileText, thisAppUrl.href, prefixes);
    asGraph.addQuads(toAdd.getQuads());
    const mergedText = await serializeTurtle(asGraph, thisAppUrl.href, prefixes);
    await Fs.promises.writeFile(appIndexFile, mergedText, {encoding: 'utf8'});
    // console.log(stomped.value, name.value, thisAppDir, this.path, this.url, footprint.url, payloadGraph.getQuads().map(
    //   q => `${q.subject.value} ${q.predicate.value} ${q.object.value}.`
    // ).join("\n"), dir);
    const rebased = await serializeTurtle(asGraph, parent, prefixes);
    return rebased;
  }

  indexInstalledFootprint (location, footprintUrl) {
    this.graph.addQuad(namedNode(location), namedNode(C.ns_foot + 'footprintRoot'), namedNode(footprintUrl.href));
    return this
  }

  reuseFootprint (footprint) {
    const m = this.graph.getQuads(null, namedNode(C.ns_foot + 'footprintRoot'), namedNode(footprint.url.href));
    if (m.length === 0)
      return null;
    /* istanbul ignore if */if (m.length > 1)
      /* istanbul ignore next */
      throw Error(`too many matches (${m.length}) for {?c, foot:footprintRoot <${footprint.url}>}`);
    return m[0].subject.value
  }

  async getRootedFootprint (cacheDir) {
    const m = this.graph.getQuads(namedNode(this.url), namedNode(C.ns_foot + 'footprintInstancePath'), null);
    /* istanbul ignore if */if (m.length === 0)
      /* istanbul ignore next */return null;
    /* istanbul ignore if */if (m.length > 1)
      /* istanbul ignore next */throw Error(`too many matches (${m.length}) for {?c, foot:footprintInstancePath _}`);
    const path = m[0].object.value;

    const o = this.graph.getQuads(namedNode(this.url), namedNode(C.ns_foot + 'footprintRoot'), null);
    /* istanbul ignore if */if (o.length === 0)
      /* istanbul ignore next */
      throw Error(`got (${o.length}) matches for {<${this.url}>, foot:footprintRoot, ?o}, expected 1`);
    return new RemoteFootprint(new URL(o[0].object.value), cacheDir, path.split(/\//))
  }

  static makeContainer (title, footprintUrl, footprintInstancePath, prefixes) {
    Object.assign(prefixes, {
      ldp: C.ns_ldp,
      xsd: C.ns_xsd,
      foot: C.ns_foot,
      dc: C.ns_dc,
    });
    const footprintTriple = footprintUrl
    ? ` ;
   foot:footprintRoot <${footprintUrl.href}> ;
   foot:footprintInstancePath "${footprintInstancePath}" ;
   foot:footprintInstanceRoot <${Path.relative(footprintInstancePath, '')}>` : '';
  return `
@prefix dcterms: <http://purl.org/dc/terms/>.
@prefix ldp: <http://www.w3.org/ns/ldp#>.
@prefix foot: <${C.ns_foot}>.

<>
   a ldp:BasicContainer ;
   dcterms:title "${title}"${footprintTriple} .
`
  }
}

class RemoteResource {
  constructor (url, cacheDir) {
    if (!(url instanceof URL)) throw Error(`url ${url} must be an instance of URL`);
    this.url = url;
    this.prefixes = {};
    this.graph = null;
    this.cacheDir = cacheDir;
    this.cachePath = Path.join(cacheDir, cacheName(url.href));
  }

  async fetch () {
    let text, mediaType;
    if (!Fs.existsSync(this.cachePath)) {
      // The first time this url was seen, put the mime type and payload in the cache.

      const resp = await Fetch(this.url.href);
      text = await resp.text();
      if (!resp.ok)
        throw Error(`GET ${this.url.href} returned ${resp.status} ${resp.statusText}\n${text}`);
      mediaType = resp.headers.get('content-type').split(/ *;/)[0];

      // Is there any real return on treating the cacheDir as a Container?
      Fs.writeFileSync(this.cachePath, `${mediaType}\n\n${text}`)
    } else {
      // Pull mime type and payload from cache.

      const cache = Fs.readFileSync(this.cachePath, 'utf8');
      [mediaType, text] = cache.match(/([^\n]+)\n\n(.*)/s).slice(1);
    }
    /* istanbul ignore next */switch (mediaType) {
    case 'application/ld+json':
      // parse the JSON-LD into n-triples
      this.graph = await parseJsonLd(text, this.url.href);
      break;
    case 'text/turtle':
      /* istanbul ignore next */this.graph = await parseTurtle (text, this.url.href, this.prefixes);
      /* istanbul ignore next */break;
    /* istanbul ignore next */
    default:
      throw Error(`unknown media type ${mediaType} when parsing ${this.url.href}`)
    }
    return this
  }
}

/** reference to a footprint stored remotely
 *
 * @param url: URL string locating footprint
 * @param path: refer to a specific node in the footprint hierarchy
 *
 * A footprint has contents:
 *     [] a rdf:FootprintRoot, ldp:BasicContainer ; foot:contents
 *
 * The contents may be ldp:Resources:
 *         [ a ldp:Resource ;
 *           foot:uriTemplate "{labelName}.ttl" ;
 *           foot:shape gh:LabelShape ] ],
 * or ldp:Containers, which may either have
 * n nested static directories:
 *         [ a ldp:BasicContainer ;
 *           rdfs:label "repos" ;
 *           foot:contents ... ] ,
 *         [ a ldp:BasicContainer ;
 *           rdfs:label "users" ;
 *           foot:contents ... ]
 * or one dynamically-named member:
 *         [ a ldp:BasicContainer ;
 *           foot:uriTemplate "{userName}" ;
 *           foot:shape gh:PersonShape ;
 *           foot:contents ]
 */
class RemoteFootprint extends RemoteResource {
  constructor (url, cacheDir, path = []) {
    super(url, cacheDir);
    this.path = path
  }

  /** getRdfRoot - Walk through the path elements to find the target node.
   */
  getRdfRoot () {
    return this.path.reduce((node, name) => {
      if (name === '.')
        return node;
      // Get the contents of the node being examined
      const cqz = this.graph.getQuads(node, namedNode(C.ns_foot + 'contents'), null);
      // Find the element which either
      return cqz.find(
        q =>
          // matches the current label in the path
          this.graph.getQuads(q.object, namedNode(C.ns_rdfs + 'label'), literal(name)).length === 1
          ||
          // or has a uriTemplate (so it should be the sole element in the contents)
          this.graph.getQuads(q.object, namedNode(C.ns_foot + 'uriTemplate'), null).length === 1
      ).object
    }, namedNode(this.url.href));
  }

  /** firstChild - return the first contents.
   */
  matchingStep (footprintNode, slug) {
    const contents = this.graph.getQuads(footprintNode, namedNode(C.ns_foot + 'contents'))
          .map(q => q.object);
    const choices = contents
          .filter(
            step => !slug ||
              new UriTemplate(
                this.graph.getQuads(step, namedNode(C.ns_foot + 'uriTemplate'))
                  .map(q2 => q2.object.value)[0]
              ).match(slug)
          );
    /* istanbul ignore if */
    if (choices.length !== 1) // Could have been caught by static analysis of footprint.
      throw Error(`Ambiguous footprint step matching ${slug} against ${contents.map(t => t.value).join(', ')}`);
    return choices[0];
  }


  /** instantiateStatic - make all containers implied by the footprint.
   * @param {RDFJS.Store} footprintGraph - context footprint in an RDF Store.
   * @param {RDFJS node} stepNode - subject of ldp:contents arcs of the LDP-Cs to be created.
   * @param {URL} rootUrl - root of the resource hierarchy (path === '/')
   * @param {string} resourcePath - filesystem path, e.g. "Share/AppStore1/repos/someOrg/someRepo"
   * @param {URL} footprintUrl - URL of context footprint
   * @param {string} pathWithinFootprint. e.g. "repos/someOrg/someRepo"
   */
  instantiateStatic (stepNode, rootUrl, resourcePath, documentRoot, pathWithinFootprint, parent) {
    const ret = new LocalContainer(rootUrl, resourcePath + Path.sep,
                                   documentRoot, C.indexFile,
                                   `index for nested resource ${pathWithinFootprint}`,
                                   this.url, pathWithinFootprint);
    parent.addMember(new URL('/' + resourcePath, rootUrl).href, stepNode.url);
    setTimeout(_ => parent.write(), 0);
    ret.addSubdirs(this.graph.getQuads(stepNode, C.ns_foot + 'contents', null).map(async t => {
      const nested = t.object;
      const labelT = this.graph.getQuads(nested, C.ns_rdfs + 'label', null);
      if (labelT.length === 0)
        return;
      /* istanbul ignore if */
      if (labelT.length > 1)
        /* istanbul ignore next */
        throw Error(`too many matches (${m.length}) for {${stepNode}, rdfs:label ?l}`);
      const toAdd = labelT[0].object.value;
      const step = new RemoteFootprint(this.url, this.cacheDir, Path.join(pathWithinFootprint, toAdd));
      step.graph = this.graph;
      return step.instantiateStatic(nested, rootUrl, Path.join(resourcePath, toAdd), documentRoot, step.path, ret);
    }));
    return ret
  }

  async validate (stepNode, mediaType, text, base, node) {
    const shapeTerm = expectOne(this.graph, stepNode, namedNode(C.ns_foot + 'shape')).object;
    const prefixes = {};
    const payloadGraph = mediaType === 'text/turtle'
          ? await parseTurtle(text, base.href, prefixes)
          : await parseJsonLd(text, base.href);
    const shape = shapeTerm.value;

    // shape is a URL with a fragement. shapeBase is that URL without the fragment.
    const shapeBase = new URL(shape);
    shapeBase.hash = '';
    const schemaResp = await Fetch(shapeBase);
    if (!schemaResp.ok)
      throw new NotFoundError(shapeTerm.value, 'schema', await schemaResp.text())
    const schemaType = schemaResp.headers.get('content-type');
    const schemaPrefixes = {}
    const schema = ShExParser.construct(shapeBase.href, schemaPrefixes, {})
          .parse(await schemaResp.text());
    const v = ShExCore.Validator.construct(schema);
    // console.warn(JSON.stringify(payloadGraph.getQuads(), null, 2))
    let res
    try {
      res = v.validate(ShExCore.Util.makeN3DB(payloadGraph), node, shape);
    } catch (e) {
      e.name = 'MissingShape';
      e.status = 424;
      throw e;
    }
    if ('errors' in res)
      throw new ValidationError(node, shape, ShExCore.Util.errsToSimple(res).join('\n'));
  }
}


/** Utility functions and classes visible only in this module
 */

function expectOne (g, s, p, o) {
  const res = g.getQuads(s, p, o);
  if (res.length !== 1)
    throw Error(`expected one answer to { ${r(s)} ${r(p)} ${r(o)} }; got ${res.length}`);
  return res[0];

  function r (t) {
    return !t ? '_' // HERE
      : typeof t === 'string' ? `<${t}>`
      : t.termType === 'NamedNode' ? `<${t.value}>`
      : t.termType === 'BlankNode' ? `_:${t.value}`
      : `"${t.value}"`;
  }
}

function cacheName (url) {
  return url.replace(/[^a-zA-Z0-9_-]/g, '');
}

function parseTurtleSync (text, base, prefixes) {
  return new N3.Parser({baseIRI: base, blankNodePrefix: "", format: "text/turtle"}).parse(text);
}

async function parseTurtle (text, base, prefixes) {
  const store = new N3.Store();
  return await new Promise((resolve, reject) => {
    new N3.Parser({baseIRI: base, blankNodePrefix: "", format: "text/turtle"}).
      parse(text,
            function (error, triple, newPrefixes) {
              /* istanbul ignore else */
              if (prefixes) {
                Object.assign(prefixes, newPrefixes)
              }
              /* istanbul ignore next */
              if (error) {
                reject(error);
              } else if (triple) {
                store.addQuad(triple);
              } else {
                // done
                resolve(store);
              }
            })
  }).catch(e => {
    throw new ParserError(e, text);
  });
}

function serializeTurtleSync (graph, base, prefixes) {
  // Create RegExp to test for matching namespaces
  // Is this faster than !Object.values(prefixes).find(ns => q[t].value.startsWith(ns) ?
  const p = new RegExp('^(?:' + Object.values(prefixes).map(
    ns => ns.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
  ).map(
    nsr => '(?:' + nsr + ')'
  ).join('|') + ')')

  const writer = new N3.Writer({ prefixes });
  writer.addQuads(graph.getQuads().map(q => {
    const terms = ['subject', 'object'];
    terms.forEach(t => {
      if (q[t].termType === 'NamedNode' // term is an IRI
          && !q[t].value.match(p))      // no applicable prefix
        q[t] = namedNode(Relateurl.relate(base, q[t].value, { output: Relateurl.ROOT_PATH_RELATIVE }))
    });
    return q
  }));
  let text
  writer.end((error, result) => {
    /* istanbul ignore next */
    if (error)
      throw Error(error);
    else
      text = result
  });
  return text;
}

async function serializeTurtle (graph, base, prefixes) {
  // Create RegExp to test for matching namespaces
  // Is this faster than !Object.values(prefixes).find(ns => q[t].value.startsWith(ns) ?
  const p = new RegExp('^(?:' + Object.values(prefixes).map(
    ns => ns.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
  ).map(
    nsr => '(?:' + nsr + ')'
  ).join('|') + ')')

  return await new Promise((resolve, reject) => {
    const writer = new N3.Writer({ prefixes });
    writer.addQuads(graph.getQuads().map(q => {
      const terms = ['subject', 'object'];
      terms.forEach(t => {
        if (q[t].termType === 'NamedNode' // term is an IRI
            && !q[t].value.match(p))      // no applicable prefix
          q[t] = namedNode(Relateurl.relate(base, q[t].value, { output: Relateurl.ROOT_PATH_RELATIVE }))
      });
      return q
    }));
    writer.end((error, result) => {
      /* istanbul ignore next */
      if (error)
        reject(error);
      else
        resolve(result)
    });
  })
}

async function parseJsonLd (text, base) {
  try {
    const qz = await Jsonld.toRDF(JSON.parse(text), {format: "application/nquads", base: base});
    // I think future minor versions will return an RDFJS list of quads.
    return parseTurtle(qz, base);
  } catch(e) {
    throw new ParserError(e, text)
  }
}

/** ParserError - adds context to jsonld.js and N3.js parse errors.
 */
class ParserError extends Error {
  constructor (e, text) {
    let message = e.message;
    if ('context' in e) { // N3.Parser().parse()
      const c = e.context;
      const lines = text.split(/\n/);
      message = `${e.message}\n  line: ${lines[c.line-1]}\n  context: ${JSON.stringify(c)}`;
    }
    if ('details' in e) { // Jsonld.expand()
      const d = e.details;
      message = `${e.message}\n  details: ${JSON.stringify(d)}`;
    }
    super(message);
    this.name = e.name;
  }
}

/** NotFoundError - adds context to jsonld.js and N3.js parse errors.
 */
class NotFoundError extends Error {
  constructor (resource, role, text) {
    let message = `${role} ${resource} not found`;
    super(message);
    this.name = 'NotFound';
    this.status = 424;
    this.text = text;
  }
}

/** ValidationError - adds context to jsonld.js and N3.js parse errors.
 */
class ValidationError extends Error {
  constructor (resource, role, text) {
    let message = `validating <${node}>@<${shape}>:\n` + text;
    super(message);
    this.name = 'Validation';
    this.status = 424;
    this.text = text;
  }
}


module.exports = {
  local: LocalResource,
  remote: RemoteResource,
  remoteFootprint: RemoteFootprint,
  localContainer: LocalContainer,
  ParserError,
  NotFoundError,
  ValidationError
};
