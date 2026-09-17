export interface TerminalTab {
  id: string;
  cwd: string;
  number: number;
  restored?: boolean;
  closing?: "close" | "restart";
}

export const TERMINAL_TABS_KEY = "pi-web:terminal-tabs";

export function newTerminalTab(cwd: string, number = 1): TerminalTab {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id, cwd, number };
}

export function nextTerminalNumber(tabs: readonly TerminalTab[], cwd: string): number {
  const used = new Set(tabs.filter((tab) => tab.cwd === cwd).map((tab) => tab.number));
  let number = 1;
  while (used.has(number)) number++;
  return number;
}

export function restoreTerminalTabs(raw: string | null): { tabs: TerminalTab[]; activeId: string | null; open: boolean } {
  try {
    const saved = JSON.parse(raw ?? "null");
    const tabs: TerminalTab[] = [];
    for (const tab of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      if (tab && typeof tab.id === "string" && /^[a-f0-9]{32}$/.test(tab.id)
        && typeof tab.cwd === "string" && tab.cwd.trim()
        && !tabs.some((existing) => existing.id === tab.id)) {
        // Older saved tabs have no number. Repair labels without changing process identity.
        const number = Number.isSafeInteger(tab.number) && tab.number > 0
          && !tabs.some((existing) => existing.cwd === tab.cwd && existing.number === tab.number)
          ? tab.number : nextTerminalNumber(tabs, tab.cwd);
        tabs.push({ id: tab.id, cwd: tab.cwd, number, restored: true });
      }
    }
    return { tabs, activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null, open: saved?.open === true };
  } catch {
    return { tabs: [], activeId: null, open: false };
  }
}
