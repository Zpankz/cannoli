import { TFile } from "obsidian";
import { v4 as uuidv4 } from "uuid";
import {
  Persistor,
  PersistorEdit,
  CannoliCanvasData,
  CanvasData,
  AllCanvasNodeData,
  CanvasEdgeData,
  AllCannoliCanvasNodeData,
  CannoliCanvasEdgeData,
  CannoliCanvasGroupData,
} from "@deablabs/cannoli-core";

export class CanvasPersistor implements Persistor {
  canvasFile: TFile;
  editQueue: Promise<unknown>;
  allowCannoliData: boolean;
  config: Record<string, unknown>;

  constructor(
    canvasData: CanvasData,
    persistor?: TFile,
    allowCannoliData: boolean = false,
  ) {
    this.allowCannoliData = allowCannoliData;

    if (!persistor) {
      throw new Error("No canvas file provided");
    }

    this.canvasFile = persistor;

    this.editQueue = Promise.resolve();
  }

  setConfig(config: Record<string, unknown>) {
    this.config = config;
  }

  async start(newCanvasData: CannoliCanvasData): Promise<void> {
    return this.mutate((data) => {
      this.removeAllErrorNodes(data);
      for (const node of newCanvasData.nodes) this.mergeNode(data, node, true);
      for (const edge of newCanvasData.edges) this.mergeEdge(data, edge, true);
    });
  }

  editNode(node: AllCannoliCanvasNodeData): Promise<void> {
    return this.mutate((data) => this.mergeNode(data, node));
  }

  editEdge(edge: CannoliCanvasEdgeData): Promise<void> {
    return this.mutate((data) => this.mergeEdge(data, edge));
  }

  /** Apply a whole flush against the current file inside one atomic vault.process. */
  applyBatch(edits: readonly PersistorEdit[]): Promise<void> {
    const snapshots = structuredClone(edits);
    return this.mutate((data) => {
      for (const edit of snapshots) {
        switch (edit.type) {
          case "node":
            this.mergeNode(data, edit.node);
            break;
          case "edge":
            this.mergeEdge(data, edit.edge);
            break;
          case "error":
            this.addErrorNode(data, edit.id.split("-")[0], edit.message);
            break;
          case "warning":
            this.addWarningNode(data, edit.id.split("-")[0], edit.message);
            break;
          case "label": {
            const node = data.nodes.find((n) => n.id === edit.id);
            if (node) (node as CannoliCanvasGroupData).label = edit.label;
          }
        }
      }
    });
  }

  async flush(): Promise<void> {
    await this.editQueue;
  }

  private mergeNode(
    data: CannoliCanvasData,
    source: AllCannoliCanvasNodeData,
    create = false,
  ): void {
    if (!this.allowCannoliData && source.cannoliData?.originalObject) return;
    const node = structuredClone(source);
    if (!this.allowCannoliData) delete node.cannoliData;
    const existing = data.nodes.find((n) => n.id === node.id);
    if (existing) {
      const { x, y, width, height } = existing;
      Object.assign(existing, node, { x, y, width, height });
    } else if (create) data.nodes.push(node);
  }

  private mergeEdge(
    data: CannoliCanvasData,
    source: CannoliCanvasEdgeData,
    create = false,
  ): void {
    if (!this.allowCannoliData && source.cannoliData?.originalObject) return;
    const edge = structuredClone(source);
    if (!this.allowCannoliData) delete edge.cannoliData;
    const existing = data.edges.find((e) => e.id === edge.id);
    if (existing) Object.assign(existing, edge);
    else if (create) data.edges.push(edge);
  }

  private mutate(edit: (data: CannoliCanvasData) => void): Promise<void> {
    this.editQueue = this.editQueue.then(() =>
      this.canvasFile.vault.process(this.canvasFile, (content) => {
        const data = JSON.parse(content) as CannoliCanvasData;
        edit(data);
        const next = JSON.stringify(data);
        return next === content ? content : next;
      }),
    );
    return this.editQueue.then(() => {});
  }

  async readCanvasData(): Promise<CannoliCanvasData> {
    return JSON.parse(await this.canvasFile.vault.read(this.canvasFile));
  }

  private addErrorNode(
    data: CanvasData,
    nodeId: string,
    error: string,
  ): CanvasData {
    const node = data.nodes.find((node) => node.id === nodeId);

    // Find the node's vertical center
    const nodeCenterY = node ? node.y + node.height / 2 : 0;

    if (node) {
      const newNodeId = this.generateNewId();
      const errorNode: AllCanvasNodeData = {
        id: newNodeId,
        x: node.x + node.width + 50,
        y: nodeCenterY - 75,
        width: 500,
        height: 150,
        color: "1",
        text: `<u>Error:</u>\n` + error,
        type: "text", // Add the 'type' property
      };
      const newEdge: CanvasEdgeData = {
        id: this.generateNewId(),
        fromNode: nodeId,
        fromSide: "right",
        toNode: newNodeId,
        toSide: "left",
        fromEnd: "none",
        toEnd: "none",
        color: "1", // red color
      };
      data.nodes.push(errorNode);
      data.edges.push(newEdge);
    }
    return data;
  }

  private addWarningNode(
    data: CanvasData,
    nodeId: string,
    error: string,
  ): CanvasData | null {
    const node = data.nodes.find((node) => node.id === nodeId);

    // Find the node's vertical center
    const nodeCenterY = node ? node.y + node.height / 2 : 0;

    if (node) {
      const newNodeId = this.generateNewId();
      const errorNode: AllCanvasNodeData = {
        id: newNodeId,
        x: node.x + node.width + 50,
        y: nodeCenterY - 75,
        width: 500,
        height: 150,
        color: "1",
        text: `<u>Warning:</u>\n` + error,
        type: "text", // Add the 'type' property
      };
      const newEdge: CanvasEdgeData = {
        id: this.generateNewId(),
        fromNode: nodeId,
        fromSide: "right",
        toNode: newNodeId,
        toSide: "left",
        fromEnd: "none",
        toEnd: "none",
        color: "1", // red color
      };

      // If there's already a node at the same position with the same text, return
      const existingWarningNode = data.nodes.find(
        (node) =>
          node.x === errorNode.x &&
          node.y === errorNode.y &&
          node.width === errorNode.width &&
          node.height === errorNode.height &&
          node.text === errorNode.text,
      );

      if (existingWarningNode) {
        return null;
      }

      data.nodes.push(errorNode);
      data.edges.push(newEdge);
    }
    return data;
  }

  private removeAllErrorNodes(data: CanvasData): CanvasData {
    // Find all error nodes (nodes that are red and have text starting with "<u>Error:</u>\n")
    const errorNodes = data.nodes.filter(
      (node) =>
        node.color === "1" &&
        (node.text?.startsWith("<u>Error:</u>\n") ||
          node.text?.startsWith("<u>Warning:</u>\n")),
    );

    // Collect all the IDs of the edges connected to error nodes
    const errorEdgeIds = new Set<string>();
    errorNodes.forEach((node) => {
      data.edges.forEach((edge) => {
        if (edge.fromNode === node.id || edge.toNode === node.id) {
          errorEdgeIds.add(edge.id);
        }
      });
    });

    // Remove all error edges
    data.edges = data.edges.filter((edge) => !errorEdgeIds.has(edge.id));

    // Remove all error nodes
    data.nodes = data.nodes.filter((node) => !errorNodes.includes(node));

    return data;
  }

  addError(nodeId: string, message: string): Promise<void> {
    return this.mutate((data) => {
      this.addErrorNode(data, nodeId.split("-")[0], message);
    });
  }

  addWarning(nodeId: string, message: string): Promise<void> {
    return this.mutate((data) => {
      this.addWarningNode(data, nodeId.split("-")[0], message);
    });
  }

  editOriginalParallelGroupLabel(
    originalGroupId: string,
    label: string,
  ): Promise<void> {
    return this.mutate((data) => {
      const node = data.nodes.find((n) => n.id === originalGroupId);
      if (node) (node as CannoliCanvasGroupData).label = label;
    });
  }

  enqueueRemoveAllErrorNodes(): Promise<void> {
    return this.mutate((data) => {
      this.removeAllErrorNodes(data);
    });
  }

  generateNewId(): string {
    return uuidv4().replace(/-/g, "").substring(0, 16);
  }
}
