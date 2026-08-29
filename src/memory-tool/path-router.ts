/**
 * Memory-tool path router — the VFS path GRAMMAR now lives in
 * waykeep-contract (it is part of the portable format's validation
 * surface; research §1.8). This shim keeps the five in-tree consumers'
 * import sites stable.
 */
export {
  MEMORY_ROOT, GLOBAL_SEGMENT, PROJECT_PREFIX, MAX_PATH_LENGTH,
  CATEGORY_KINDS, vfsOwnedKinds,
  encodeProjectSegment, decodeProjectSegment,
  normalizeMemoryPath, routeMemoryPath, canonicalPathFor,
  invalidPathMessage,
  type Category, type RoutedPath,
} from 'waykeep-contract';
