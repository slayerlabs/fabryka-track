import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./contracts/upload-v1.schema.json" with { type: "json" };
export type {
  CreateUpload,
  UploadSession,
  PartRequest,
  TransferGrant,
  ConfirmUpload,
  JobStatus,
  JobReport,
  DownloadGrant,
  CancelJob,
  FileMetadata,
  ErrorBody,
} from "./types.ts";

const ajv = new Ajv2020({ allErrors: false, strict: false });
addFormats(ajv);
const decoders = new Map<string, ReturnType<typeof ajv.compile>>();

export function decode<T>(name: string, input: unknown): T {
  let validate = decoders.get(name);
  if (!validate) {
    if (!Object.hasOwn(schema.$defs, name)) throw new Error("unknown_contract_message");
    validate = ajv.compile({ $ref: "#/$defs/" + name, $defs: schema.$defs });
    decoders.set(name, validate);
  }
  if (!validate(input)) throw new Error("invalid_controller_response");
  return input as T;
}
