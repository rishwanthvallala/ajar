// Executes only the isolated carry/hash functions extracted from the fetched
// deployed helper bundle. No browser or network request; no product mutation.
const fs = require('node:fs');
const ts = require('typescript');
const file = __dirname + '/live-problems-CVQixfdG.js';
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ast.statements.filter(ts.isFunctionDeclaration);
const hashes = functions.filter(n => n.getText(ast).includes('16777619'));
const carry = functions.find(n => n.name?.text === 'fi');
const whole = functions.find(n => n.name?.text === '$t');
if (!carry || !whole || hashes.length < 2) throw Error('Expected deployed functions missing');
const merge = new Function(whole.getText(ast) + '\n' + carry.getText(ast) + '\nreturn fi;')();
const base = 'A\nB\nC\n', mine = 'a\nB\nc\n', theirs = 'A\nB!\nC\n';
const change = merge(base, mine, theirs);
const output = theirs.slice(0, change.at) + change.insert + theirs.slice(change.at + change.remove);
const paths = ['file-1ezsubx.txt', 'file-6yp6oj.txt'];
const records = hashes.map(n => {
  const fn = new Function('return (' + n.getText(ast) + ')')();
  return { name: n.name.text, offset: n.getStart(ast), snippet: n.getText(ast), values: paths.map(p => ({ path: p, id: fn(p) })) };
});
const result = { asset: file, merge: { name: carry.name.text, offset: carry.getStart(ast), baseline: base, local: mine, other: theirs, observed: output, expected: 'a\nB!\nc\n' }, hashes: records };
fs.writeFileSync(__dirname + '/deployed-data-functions.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
