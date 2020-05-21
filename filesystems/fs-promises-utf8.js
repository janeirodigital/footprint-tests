const Fs = require('fs');
const Path = require('path');

class fsPromiseUtf8 {
  constructor (docRoot, indexFile, rdfInterface) {
    // Make sure there's only one filesystem interface for given docRoot.
    // This will need to be moved to an async function if multiple apps
    // use a filesystem to coordinate access.
    const key = docRoot;
    if (fsPromiseUtf8[key])
      return fsPromiseUtf8[key];

    this.docRoot = docRoot;
    this.indexFile = indexFile;
    this._rdfInterface = rdfInterface;
    fsPromiseUtf8[key] = this;
    this.promises = {}; // hash[path, list[promises]]
    this._hashCode = `fsPromiseUtf8(${JSON.stringify(key)})`; // Math.floor(Math.random()*2**32).toString(16); // identifies this singleton
  }

  hashCode () { return this._hashCode; }

  // Status

  /** exists:boolean - Test if resource exists.
   * @returns: true if resource exists, false if not
   */
  async exists (url) {
    return Fs.promises.stat(Path.join(this.docRoot, url.pathname)).then(s => true, e => false);
  }

  /** rstat:object - Describe existing resource.
   * @returns: {
   *   isContainer - whether the resource is a Container
   * }
   * @throws: resource does not exist
   */
  async rstat (url) {
    const lstat = await Fs.promises.lstat(Path.join(this.docRoot, url.pathname));
    return { isContainer: lstat.isDirectory() };
  }

  /** suggestName:strong|void - find a name for a new container member
   * @returns: name if f is null, f(name) otherwise
   */
  async suggestName (parentUrl, slug, type, f) {
    let unique = 0;
    let tested;
    while (await this.exists(
      new URL(
        tested = (slug || type) + (
          unique > 0
            ? '-' + unique
            : ''
        ) + (type === 'Container' ? '/' : ''), parentUrl)
    ))
      ++unique;
    const ret = f ? await f(new URL(tested, parentUrl)) : tested;
    return ret;
  }


  // R/W/D Resources

  /** read:string - Read contents of resource.
   * @returns: contents
   * @throws: resource does not exist
   */
  async read (url) {
    return Fs.promises.readFile(Path.join(this.docRoot, url.pathname), 'utf8');
  }

  /** write:undefined - Write contents to resource.
   * @param body: contents to be written
   * @throws: resource does not exist
   */
  async write (url, body) {
    return Fs.promises.writeFile(Path.join(this.docRoot, url.pathname), body, {encoding: 'utf8'});
  }

  /** remove:undefined - Delete resource.
   * @throws: resource does not exist
   */
  async remove (url) {
    return Fs.promises.unlink(Path.join(this.docRoot, url.pathname));
  }

  // R/W/D Containers

  /** readContainer:RDFJS Store - Read body of Container.
   * @returns: body parsed as RDF
   * @param prefixes: where to capures prefixes from parsing
   * @throws:
   *   resource does not exist
   *   parser failures
   */
  async readContainer (url, prefixes) {
    const text = await Fs.promises.readFile(Path.join(this.docRoot, this.getIndexFilePath(url)), 'utf8');
    return this._rdfInterface.parseTurtle(text, url, prefixes);
  }

  /** writeContainer:undefined - Read body of Container.
   * @param graph: data to be written
   * @param prefixes: prefixes to be used in serialization
   * @throws:
   *   resource does not exist
   *   serializer failures
   */
  async writeContainer (graph, url, prefixes) {
    const body = await this._rdfInterface.serializeTurtle(graph, url, prefixes);
    return Fs.promises.writeFile(Path.join(this.docRoot, this.getIndexFilePath(url)), body, {encoding: 'utf8'});
  }

  /** remove:undefined - Recursively remove a Container.
   * @throws: resource does not exist
   */
  async removeContainer (url) {
    const path = Path.join(this.docRoot, url.pathname);
    const files = await Fs.promises.readdir(path);
    for (const f of files) {
      const child = Path.join(path, f);
      const lstat = await Fs.promises.lstat(child);
      const childUrl = new URL(f, url);
      if (lstat.isDirectory()) {
        childUrl.pathname += '/'
        await this.removeContainer(childUrl);
      } else {
        await this.remove(childUrl);
      }
    }
    await Fs.promises.rmdir(path);
  }


  /** ensureContainer:object - Make Container with invented contents if it doesn't already exist.
   * @param prefixes: prefixes helpful for serialization.
   * @param title: dc:title property to add to invented contents.
   * @returns: [
   *   boolean - whether Container is new (didn't exist),
   *   RDFJS Store - data either read from Container or written to Container
   * ]
   * @throws:
   *   resource does not exist
   *   serializer failures
   */
  async ensureContainer (url, prefixes, title) {
    const _fsPromiseUtf8 = this;
    return Fs.promises.mkdir(Path.join(this.docRoot, url.pathname)).then(
      async () => {
        const g = await makeContainer();
        return [true, g];
      },
      async e => {
        /* istanbul ignore else */
        if (e.code === 'EEXIST') {
          try {
            const g = await this.readContainer(url, prefixes);
            return [false, g];
          } catch (e) {
            const g = await makeContainer();
            return [true, g];
          }
        }
        /* istanbul ignore next */
        throw e;
      }
    )

    async function makeContainer () {
      const body = `
@prefix dcterms: <http://purl.org/dc/terms/>.
@prefix ldp: <http://www.w3.org/ns/ldp#>.

<> a ldp:BasicContainer;
   dcterms:title "${title}".
`;
      const graph = await _fsPromiseUtf8._rdfInterface.parseTurtle(body, url, prefixes);
      _fsPromiseUtf8.writeContainer(graph, url, prefixes);
      return graph;
    }
  }

  /** getIndexFilePath:string - Get the index Resource for a given Container.
   */
  getIndexFilePath (url) { // This is in the public API 'cause the static file server needs it.
    return Path.join(url.pathname, this.indexFile);
  }
}

module.exports = fsPromiseUtf8;
