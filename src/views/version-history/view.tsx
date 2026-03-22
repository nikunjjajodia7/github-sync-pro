import { IconName, ItemView, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import GitHubSyncPlugin from "src/main";
import { PluginContext } from "../hooks";
import VersionHistoryView from "./history-view";

export const VERSION_HISTORY_VIEW_TYPE = "version-history-view";

export class VersionHistoryItemView extends ItemView {
  icon: IconName = "history";
  private root: Root | null = null;
  private filePath: string;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: GitHubSyncPlugin,
    filePath: string,
  ) {
    super(leaf);
    this.filePath = filePath;
  }

  getViewType() {
    return VERSION_HISTORY_VIEW_TYPE;
  }

  getDisplayText() {
    return `History: ${this.filePath.split("/").pop() || this.filePath}`;
  }

  setFilePath(filePath: string) {
    this.filePath = filePath;
    this.render();
  }

  async onOpen() {
    this.render();
  }

  private render() {
    if (!this.root) {
      const container = this.containerEl.children[1];
      container.empty();
      (container as HTMLElement).style.height = "100%";
      this.root = createRoot(container);
    }

    this.root.render(
      <PluginContext.Provider value={this.plugin}>
        <VersionHistoryView filePath={this.filePath} />
      </PluginContext.Provider>,
    );
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}
