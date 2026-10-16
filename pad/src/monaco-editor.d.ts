declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}
declare module "monaco-editor/esm/vs/basic-languages/*";
declare module "monaco-editor/esm/vs/base/common/errors.js" {
  export const errorHandler: { unexpectedErrorHandler: (e: unknown) => void };
}
