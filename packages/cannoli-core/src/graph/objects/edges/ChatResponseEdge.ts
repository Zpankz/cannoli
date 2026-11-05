import type { ExecutionPayload } from "../../CannoliObject";
import { GenericCompletionParams } from "src/providers";
import { CannoliEdge } from "../CannoliEdge";
import { chatFormatString } from "./ChatConverterEdge";

export class ChatResponseEdge extends CannoliEdge {
  beginningOfStream = true;

  async execute(payload?: ExecutionPayload): Promise<void> {
    if (payload) this.setContent(payload.content);
    this.completed(payload);
  }

  load({
    content,
    request,
  }: {
    content?: string | Record<string, string>;
    request?: GenericCompletionParams;
  }): void {
    const format =
      this.run.config?.chatFormatString?.toString() ?? chatFormatString;

    if (!format) {
      throw new Error("Chat response edge was loaded without a format string");
    }

    if (content && typeof content === "string") {
      let chunk: string;
      if (!this.beginningOfStream) {
        // If the content is the string "END OF STREAM"
        if (content === "END OF STREAM") {
          // Create a user template for the next message
          const userTemplate = format
            .replace("{{role}}", "User")
            .replace("{{content}}", "");

          chunk = "\n\n" + userTemplate;
        } else {
          chunk = content;
        }
      } else {
        const assistantTemplate = format
          .replace("{{role}}", "Assistant")
          .replace("{{content}}", content);

        chunk = "\n\n" + assistantTemplate;

        this.beginningOfStream = false;
      }

      this.queueExecution({ content: chunk, append: true });
    }
  }
}
