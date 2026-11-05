import { tool } from "@langchain/core/tools";
import { safeKeyName } from "src/utility";
import { z } from "zod-v4";

// Legacy LangChain converts Zod v3 only. Keep its JSON Schema boundary, then
// parse with native v4 so validation and unknown-key stripping stay intact.
export const choiceTool = <T extends string>(choices: [T, ...T[]]) => {
  const schema = z.object({ choice: z.enum(choices) });
  return tool((input) => schema.parse(input).choice, {
    name: "choice",
    description: "Choose one of the following options",
    schema: z.toJSONSchema(schema, { io: "input" }),
  });
};

export const noteSelectTool = <T extends string>(notes: [T, ...T[]]) => {
  const schema = z.object({ note: z.enum(notes) });
  return tool((input) => schema.parse(input).note, {
    name: "note_select",
    description: "Select one of the following notes",
    schema: z.toJSONSchema(schema, { io: "input" }),
  });
};

export const formTool = (fields: string[]) => {
  const schema = z.object(
    Object.fromEntries(fields.map((field) => [safeKeyName(field), z.string()])),
  );
  return tool((input) => schema.parse(input).fields, {
    name: "form",
    description: "Generate a value for each field",
    schema: z.toJSONSchema(schema, { io: "input" }),
  });
};
