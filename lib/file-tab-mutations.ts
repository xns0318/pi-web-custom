import { fileInWorkspace } from "./file-editor-state";
import { getFileName } from "./file-paths";
import type { FileMutation } from "./workspace-file-types";
import type { Tab } from "../components/TabBar";

export function applyFileMutation(tabs: Tab[], result: FileMutation): Tab[] {
  if (result.operation === "delete") return tabs.filter((tab) => !fileInWorkspace(tab.filePath, result.path));
  if (result.operation !== "rename" || !result.newPath) return tabs;
  const destination = result.newPath;
  return tabs.filter((tab) => !fileInWorkspace(tab.filePath, destination)).map((tab) => {
    if (!fileInWorkspace(tab.filePath, result.path)) return tab;
    const filePath = destination + tab.filePath.slice(result.path.length);
    return { ...tab, id: `file:${filePath}`, filePath, label: getFileName(filePath), viewerRevision: (tab.viewerRevision ?? 0) + 1 };
  });
}
