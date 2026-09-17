// Shared browser/server contract. No filesystem imports in this module.
export const EDIT_MAX_BYTES = 1024 * 1024;
export type FileOperation = "create-file" | "create-directory" | "rename" | "delete";
export interface FileAction {
  operation: FileOperation;
  workspace: string;
  path: string;
}
export interface FileInspection {
  path: string;
  kind: "file" | "directory";
  version: string;
  empty?: boolean;
}
export interface EditableFile {
  content: string;
  version: string;
  eol: "\n" | "\r\n";
  bom: boolean;
}
export interface FileMutation {
  operation: FileOperation;
  workspace: string;
  path: string;
  newPath?: string;
  kind: "file" | "directory";
}
