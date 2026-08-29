/**
 * Round-trip format v2 — now owned by cairn-contract (it IS the portable
 * format). This shim keeps in-tree import sites stable.
 */
export {
  PORTABLE_FIELDS,
  canonicalJson, buildRecordSection, buildFileSection,
  assertPortableFilePath, validateContextShape, validateFingerprintShape,
  validateRecordPayload, parseExportDocument,
  type PortableRecord, type PortableFile, type ParsedExport,
} from 'cairn-contract';
