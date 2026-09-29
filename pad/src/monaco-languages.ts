/**
 * The formats the editor colours — see languages.ts.
 *
 * Each import only registers a language: its name, extensions, and a loader
 * for the tokenizer, which is fetched the first time a file needs it. The list
 * is what people paste into a shared editor, not all eighty Monaco knows.
 *
 * Registering any language also loads Monaco's standard editor features —
 * find and replace, comment toggling, bracket matching, folding — which the
 * bare API the pad loaded before did not have either.
 */
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution.js";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js";
import "monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/julia/julia.contribution.js";
import "monaco-editor/esm/vs/basic-languages/objective-c/objective-c.contribution.js";
import "monaco-editor/esm/vs/basic-languages/elixir/elixir.contribution.js";
import "monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution.js";
import "monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution.js";
