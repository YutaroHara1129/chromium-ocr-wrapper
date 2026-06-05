import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { runCli, handleCliError } from "./cli.js";

const _isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (_isDirectExecution) {
  runCli(process.argv).catch(handleCliError);
}
