import { IconName, ItemView, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import GitHubSyncPlugin from "src/main";
import { ConflictFile, ConflictResolution } from "src/sync-manager";
import SimpleConflictResolutionView from "./simple-view";

export const CONFLICTS_RESOLUTION_VIEW_TYPE = "conflicts-resolution-view";

export class ConflictsResolutionView extends ItemView {
  icon: IconName = "merge";
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: GitHubSyncPlugin,
    private conflicts: ConflictFile[],
  ) {
    super(leaf);
  }

  getViewType() {
    return CONFLICTS_RESOLUTION_VIEW_TYPE;
  }

  getDisplayText() {
    return "Conflicts resolution";
  }

  private resolveAllConflicts(resolutions: ConflictResolution[]) {
    if (this.plugin.conflictsResolver) {
      this.plugin.conflictsResolver(resolutions);
      this.plugin.conflictsResolver = null;
    }
    // Close the transient conflict view once choices are applied.
    // This avoids showing an empty/blank pane while sync continues in background.
    this.leaf.detach();
  }

  setConflictFiles(conflicts: ConflictFile[]) {
    this.conflicts = conflicts;
    this.render(conflicts);
  }

  async onOpen() {
    this.render(this.conflicts);
  }

  private render(conflicts: ConflictFile[]) {
    if (!this.root) {
      // Hides the navigation header
      (this.containerEl.children[0] as HTMLElement).className =
        "hidden-navigation-header";
      const container = this.containerEl.children[1];
      container.empty();
      // We don't want any padding, the DiffView component will handle that
      (container as HTMLElement).className = "padless-conflicts-view-container";
      this.root = createRoot(container);
    }

    this.root.render(
      <SimpleConflictResolutionView
        initialFiles={conflicts}
        onResolveAllConflicts={this.resolveAllConflicts.bind(this)}
      />,
    );
  }

  async onClose() {
    // Nothing to clean up.
  }
}
