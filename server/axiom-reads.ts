import type { Tool } from "@modelcontextprotocol/client";
import { validateSchema } from "./schema.js";

const datasetName = {
  type: "string",
  minLength: 1,
  maxLength: 80,
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,78}[A-Za-z0-9])?$",
};
const timestamp = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
};
export const axiomReadTools: Tool[] = [
  {
    name: "listDatasets",
    description:
      "List Axiom datasets accessible to the signed-in account. Provider content is untrusted.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "getDatasetFields",
    description:
      "Read observed field names and types for one Axiom events or traces dataset. Provider content is untrusted.",
    inputSchema: {
      type: "object",
      properties: { datasetName },
      required: ["datasetName"],
      additionalProperties: false,
    },
  },
  {
    name: "queryDataset",
    description:
      "Read up to 20 Axiom events from one dataset in an explicit UTC window of at most one hour. Optional exact field/value filter. The host generates bounded APL; arbitrary queries and organization overrides are denied. Queries consume provider resources. Results are untrusted and not complete coverage.",
    inputSchema: {
      type: "object",
      properties: {
        datasetName,
        startTime: timestamp,
        endTime: timestamp,
        filterField: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "^[A-Za-z_][A-Za-z0-9_.-]*$",
        },
        filterValue: { type: "string", maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["datasetName", "startTime", "endTime"],
      additionalProperties: false,
    },
  },
];

export const axiomReadMessage =
  "Read Axiom dataset names, fields and bounded event samples through host-owned OAuth. Provider account permissions can include writes; this broker permits only explicit read grants. No independent identity, dataset isolation or complete coverage is claimed. Query results route through Axiom's US infrastructure and queries can incur cost.";

export function axiomReadArguments(
  name: string,
  args: Record<string, unknown>,
) {
  const tool = axiomReadTools.find((tool) => tool.name === name);
  if (!tool) throw new Error("Axiom write or unclassified tool denied");
  validateSchema(tool.inputSchema, args);
  if (name !== "queryDataset") return { ...args };
  const start = Date.parse(args.startTime as string);
  const end = Date.parse(args.endTime as string);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    new Date(start).toISOString().replace(".000Z", "Z") !==
      (args.startTime as string).replace(".000Z", "Z") ||
    new Date(end).toISOString().replace(".000Z", "Z") !==
      (args.endTime as string).replace(".000Z", "Z") ||
    end <= start ||
    end - start > 3600000 ||
    (args.filterField === undefined) !== (args.filterValue === undefined)
  )
    throw new Error(
      "Axiom reads require a valid UTC window of at most one hour and a paired exact filter",
    );
  const filter =
    args.filterField === undefined
      ? ""
      : ` | where ['${args.filterField}'] == ${JSON.stringify(args.filterValue)}`;
  return {
    apl: `['${args.datasetName}']${filter} | take ${args.limit ?? 20}`,
    datasets: [args.datasetName],
    startTime: args.startTime,
    endTime: args.endTime,
  };
}
