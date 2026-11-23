import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import type { QuickJSSyncVariant } from '@jitl/quickjs-ffi-types';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';

// Node ESM and the desktop bundler use different CommonJS default interop.
function unwrap(value: QuickJSSyncVariant | { default: QuickJSSyncVariant }) {
  return 'default' in value ? value.default : value;
}
let engine: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
export function quickJS() {
  return engine ??= newQuickJSWASMModuleFromVariant(unwrap(variant));
}
